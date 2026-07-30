"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3000);
const LLAMA_PORT = Number(process.env.LLAMA_PORT || 8080);
const LLAMA_HOST = "127.0.0.1";

const LLAMA_SERVER_PATH =
    process.env.LLAMA_SERVER_PATH ||
    path.join(
        __dirname,
        "llama.cpp",
        "build",
        "bin",
        "llama-server"
    );

// 360M tabanlı coder model.
// Q2_K yaklaşık 219 MB olduğundan 512 MB ortam için en olası sürümdür.
const MODEL_REPOSITORY =
    process.env.MODEL_REPOSITORY ||
    "mradermacher/SolaraV2-coder-GGUF";

const MODEL_QUANT =
    process.env.MODEL_QUANT ||
    "Q2_K";

const MODEL_REFERENCE = `${MODEL_REPOSITORY}:${MODEL_QUANT}`;

const LLAMA_CONTEXT_SIZE = Number(
    process.env.LLAMA_CONTEXT_SIZE || 1024
);

const LLAMA_THREADS = Number(
    process.env.LLAMA_THREADS || 2
);

const MAX_OUTPUT_TOKENS = Number(
    process.env.MAX_OUTPUT_TOKENS || 256
);

const MAX_HISTORY_MESSAGES = Number(
    process.env.MAX_HISTORY_MESSAGES || 8
);

const LLAMA_API_URL =
    `http://${LLAMA_HOST}:${LLAMA_PORT}`;

let llamaProcess = null;
let llamaReady = false;
let llamaStarting = false;

// =================================
// MIDDLEWARE
// =================================

app.use(cors());

app.use(
    express.json({
        limit: "2mb"
    })
);

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

// =================================
// VERİ.TXT OKUMA
// =================================

// 512 MB RAM ve 1024 context nedeniyle veri.txt'nin
// tamamını her istekte modele göndermiyoruz.
let codeKnowledgeLines = [];

try {
    const veriPath = path.join(__dirname, "veri.txt");

    if (fs.existsSync(veriPath)) {
        const content = fs.readFileSync(veriPath, "utf8");

        codeKnowledgeLines = content
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);

        console.log(
            `📄 veri.txt okundu: ${codeKnowledgeLines.length} satır`
        );
    } else {
        console.warn(
            "⚠️ veri.txt bulunamadı. Bilgi tabanı olmadan devam ediliyor."
        );
    }
} catch (error) {
    console.error(
        "❌ veri.txt okunamadı:",
        error.message
    );
}

// =================================
// BASİT BİLGİ ARAMA
// =================================

function normalizeText(text) {
    return String(text || "")
        .toLocaleLowerCase("tr-TR")
        .replace(/[^\p{L}\p{N}_+#.-]+/gu, " ")
        .trim();
}

function findRelevantKnowledge(query, maximumLines = 12) {
    if (
        !query ||
        codeKnowledgeLines.length === 0
    ) {
        return "";
    }

    const ignoredWords = new Set([
        "bir",
        "bu",
        "şu",
        "ve",
        "veya",
        "ile",
        "için",
        "nasıl",
        "nedir",
        "olan",
        "bana",
        "kod",
        "yaz",
        "yapar",
        "yap"
    ]);

    const words = normalizeText(query)
        .split(/\s+/)
        .filter(word => word.length >= 3)
        .filter(word => !ignoredWords.has(word));

    if (words.length === 0) {
        return "";
    }

    const scoredLines = codeKnowledgeLines
        .map(line => {
            const normalizedLine = normalizeText(line);

            let score = 0;

            for (const word of words) {
                if (normalizedLine.includes(word)) {
                    score += 1;
                }
            }

            return {
                line,
                score
            };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maximumLines);

    if (scoredLines.length === 0) {
        return "";
    }

    // Promptun aşırı büyümesini engelle.
    return scoredLines
        .map(item => item.line)
        .join("\n")
        .slice(0, 5000);
}

// =================================
// SİSTEM PROMPTU
// =================================

function createSystemPrompt(knowledge) {
    let prompt = `
Sen Java AI'sın.

Kahve temalı bir yazılım asistanısın.
Özellikle Java, JavaScript, TypeScript, HTML, CSS ve Node.js alanlarında yardımcı olursun.

Kurallar:
- Kısa ve net cevap ver.
- İstenen kodu doğrudan üret.
- Var olmayan kütüphaneler uydurma.
- Kodda hata varsa düzelt.
- Küçük bir model olduğun için karmaşık işi parçalara ayır.
- Gereksiz uzun açıklamalar yapma.
- Türkçe cevap ver.
- Kullanıcının önceki mesaj bağlamını mümkün olduğunca koru.
`.trim();

    if (knowledge) {
        prompt += `

Aşağıdaki bilgi veri.txt içinden seçilmiştir.
Yalnızca soruyla alakalıysa kullan:

--- İLGİLİ BİLGİ ---
${knowledge}
--- BİLGİ SONU ---`;
    }

    return prompt;
}

// =================================
// LLAMA SERVER YÖNETİMİ
// =================================

function startLlamaServer() {
    if (llamaProcess || llamaStarting) {
        return;
    }

    llamaStarting = true;
    llamaReady = false;

    if (!fs.existsSync(LLAMA_SERVER_PATH)) {
        console.error(
            "❌ llama-server bulunamadı:",
            LLAMA_SERVER_PATH
        );

        llamaStarting = false;
        return;
    }

    console.log("🦙 llama-server başlatılıyor...");
    console.log(`🤖 Model: ${MODEL_REFERENCE}`);
    console.log(`🧠 Context: ${LLAMA_CONTEXT_SIZE}`);
    console.log(`🧵 Thread: ${LLAMA_THREADS}`);

    const argumentsList = [
        "-hf",
        MODEL_REFERENCE,

        "--host",
        LLAMA_HOST,

        "--port",
        String(LLAMA_PORT),

        "--ctx-size",
        String(LLAMA_CONTEXT_SIZE),

        "--threads",
        String(LLAMA_THREADS),

        "--threads-batch",
        String(LLAMA_THREADS),

        "--parallel",
        "1",

        "--batch-size",
        "64",

        "--ubatch-size",
        "32",

        "--no-mmap"
    ];

    llamaProcess = spawn(
        LLAMA_SERVER_PATH,
        argumentsList,
        {
            cwd: __dirname,
            stdio: [
                "ignore",
                "pipe",
                "pipe"
            ],
            env: {
                ...process.env,

                // Model indirme klasörü.
                LLAMA_CACHE:
                    process.env.LLAMA_CACHE ||
                    path.join(__dirname, ".llama-cache")
            }
        }
    );

    llamaProcess.stdout.on("data", data => {
        const output = data.toString().trim();

        if (output) {
            console.log(`[LLAMA] ${output}`);
        }
    });

    llamaProcess.stderr.on("data", data => {
        const output = data.toString().trim();

        if (output) {
            console.log(`[LLAMA] ${output}`);
        }
    });

    llamaProcess.on("error", error => {
        console.error(
            "❌ llama-server başlatılamadı:",
            error.message
        );

        llamaProcess = null;
        llamaReady = false;
        llamaStarting = false;
    });

    llamaProcess.on("close", code => {
        console.error(
            `⚠️ llama-server kapandı. Kod: ${code}`
        );

        llamaProcess = null;
        llamaReady = false;
        llamaStarting = false;
    });

    waitForLlamaServer()
        .then(() => {
            llamaReady = true;
            llamaStarting = false;

            console.log(
                "✅ Yerel 360M Coder modeli hazır."
            );
        })
        .catch(error => {
            llamaReady = false;
            llamaStarting = false;

            console.error(
                "❌ Model hazır duruma gelemedi:",
                error.message
            );
        });
}

async function waitForLlamaServer() {
    const maximumAttempts = 180;

    for (
        let attempt = 1;
        attempt <= maximumAttempts;
        attempt++
    ) {
        try {
            const response = await fetch(
                `${LLAMA_API_URL}/health`,
                {
                    signal: AbortSignal.timeout(3000)
                }
            );

            if (response.ok) {
                return;
            }
        } catch {
            // Model hâlâ indiriliyor veya yükleniyor olabilir.
        }

        if (attempt % 10 === 0) {
            console.log(
                `⏳ Model bekleniyor... ${attempt}/${maximumAttempts}`
            );
        }

        await new Promise(resolve =>
            setTimeout(resolve, 2000)
        );
    }

    throw new Error(
        "llama-server zamanında hazır olmadı."
    );
}

// =================================
// MESAJ TEMİZLEME
// =================================

function sanitizeHistory(history) {
    return history
        .filter(message => {
            return (
                message &&
                typeof message === "object" &&
                ["user", "assistant"].includes(message.role) &&
                typeof message.content === "string"
            );
        })
        .map(message => ({
            role: message.role,
            content: message.content.slice(0, 6000)
        }))
        .slice(-MAX_HISTORY_MESSAGES);
}

function getLastUserMessage(history) {
    for (
        let index = history.length - 1;
        index >= 0;
        index--
    ) {
        if (history[index].role === "user") {
            return history[index].content;
        }
    }

    return "";
}

// =================================
// CHAT API
// =================================

app.post("/api/chat", async (req, res) => {
    try {
        const { history } = req.body;

        if (
            !Array.isArray(history) ||
            history.length === 0
        ) {
            return res.status(400).json({
                error:
                    "Geçerli bir sohbet geçmişi gönderilmedi."
            });
        }

        if (!llamaReady) {
            return res.status(503).json({
                error:
                    "Yerel model henüz indiriliyor veya yükleniyor.",
                loading: true
            });
        }

        const recentHistory =
            sanitizeHistory(history);

        if (recentHistory.length === 0) {
            return res.status(400).json({
                error:
                    "Geçerli kullanıcı mesajı bulunamadı."
            });
        }

        const lastUserMessage =
            getLastUserMessage(recentHistory);

        const relevantKnowledge =
            findRelevantKnowledge(lastUserMessage);

        const systemPrompt =
            createSystemPrompt(relevantKnowledge);

        const messages = [
            {
                role: "system",
                content: systemPrompt
            },
            ...recentHistory
        ];

        const controller =
            new AbortController();

        const timeout = setTimeout(() => {
            controller.abort();
        }, 120000);

        let response;

        try {
            response = await fetch(
                `${LLAMA_API_URL}/v1/chat/completions`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({
                        model: MODEL_REFERENCE,
                        messages,

                        temperature: 0.4,
                        top_p: 0.9,
                        top_k: 40,

                        max_tokens:
                            MAX_OUTPUT_TOKENS,

                        stream: false
                    }),

                    signal: controller.signal
                }
            );
        } finally {
            clearTimeout(timeout);
        }

        const rawText = await response.text();

        let result;

        try {
            result = JSON.parse(rawText);
        } catch {
            throw new Error(
                `llama-server geçersiz cevap döndürdü: ${rawText.slice(0, 300)}`
            );
        }

        if (!response.ok) {
            throw new Error(
                result.error?.message ||
                result.error ||
                `Yerel model hatası: HTTP ${response.status}`
            );
        }

        const reply =
            result.choices?.[0]?.message?.content?.trim();

        if (!reply) {
            throw new Error(
                "Model boş cevap döndürdü."
            );
        }

        return res.json({
            reply,
            local: true,
            model: MODEL_REFERENCE,
            usage: result.usage || null
        });
    } catch (error) {
        console.error(
            "❌ Chat hatası:",
            error
        );

        if (error.name === "AbortError") {
            return res.status(504).json({
                error:
                    "Yerel model zaman aşımına uğradı."
            });
        }

        return res.status(500).json({
            error:
                "Yerel model cevap üretirken hata oluştu.",
            details: error.message
        });
    }
});

// =================================
// DURUM API
// =================================

app.get("/api/status", (req, res) => {
    res.json({
        server: "online",
        modelReady: llamaReady,
        modelStarting: llamaStarting,
        model: MODEL_REFERENCE,
        contextSize: LLAMA_CONTEXT_SIZE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        knowledgeLines: codeKnowledgeLines.length
    });
});

// =================================
// HEALTH CHECK
// =================================

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "ok",
        modelReady: llamaReady
    });
});

// =================================
// KAPATMA
// =================================

function shutdown(signal) {
    console.log(`\n🛑 ${signal} alındı.`);

    if (llamaProcess) {
        llamaProcess.kill("SIGTERM");
    }

    process.exit(0);
}

process.on("SIGTERM", () =>
    shutdown("SIGTERM")
);

process.on("SIGINT", () =>
    shutdown("SIGINT")
);

// =================================
// SERVER BAŞLATMA
// =================================

app.listen(PORT, "0.0.0.0", () => {
    console.log(`
========================================
       ☕ JAVA AI - LOCAL CODER
========================================
Web portu        : ${PORT}
Yerel model portu: ${LLAMA_PORT}
Model            : ${MODEL_REFERENCE}
Context          : ${LLAMA_CONTEXT_SIZE}
Maksimum çıktı   : ${MAX_OUTPUT_TOKENS}
Groq API         : Kullanılmıyor
API anahtarı     : Gerekmiyor
Durum            : Express hazır
========================================
    `);

    startLlamaServer();
});