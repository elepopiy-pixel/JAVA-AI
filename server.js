"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const LLAMA_PORT = Number(process.env.LLAMA_PORT || 8080);
const LLAMA_HOST = "127.0.0.1";

const LLAMA_SERVER_PATH =
    process.env.LLAMA_SERVER_PATH || "/usr/local/bin/llama-server";

const MODEL_REPOSITORY =
    process.env.MODEL_REPOSITORY ||
    "mradermacher/SolaraV2-coder-GGUF";

const MODEL_QUANT = process.env.MODEL_QUANT || "Q2_K";
const MODEL_REFERENCE = `${MODEL_REPOSITORY}:${MODEL_QUANT}`;

const LLAMA_CONTEXT_SIZE = positiveInteger(
    process.env.LLAMA_CONTEXT_SIZE,
    768
);

const LLAMA_THREADS = positiveInteger(
    process.env.LLAMA_THREADS,
    1
);

const MAX_OUTPUT_TOKENS = positiveInteger(
    process.env.MAX_OUTPUT_TOKENS,
    192
);

const MAX_HISTORY_MESSAGES = positiveInteger(
    process.env.MAX_HISTORY_MESSAGES,
    6
);

const LLAMA_API_URL = `http://${LLAMA_HOST}:${LLAMA_PORT}`;

let llamaProcess = null;
let llamaReady = false;
let llamaStarting = false;
let lastLlamaError = null;

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// =================================
// veri.txt
// =================================

let codeKnowledgeLines = [];

try {
    const veriPath = path.join(__dirname, "veri.txt");

    if (fs.existsSync(veriPath)) {
        codeKnowledgeLines = fs
            .readFileSync(veriPath, "utf8")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

        console.log(
            `📄 veri.txt okundu: ${codeKnowledgeLines.length} satır`
        );
    } else {
        console.warn("⚠️ veri.txt bulunamadı.");
    }
} catch (error) {
    console.error("❌ veri.txt okunamadı:", error.message);
}

function normalizeText(value) {
    return String(value || "")
        .toLocaleLowerCase("tr-TR")
        .replace(/[^\p{L}\p{N}_+#.-]+/gu, " ")
        .trim();
}

function findRelevantKnowledge(query, limit = 8) {
    if (!query || codeKnowledgeLines.length === 0) {
        return "";
    }

    const ignored = new Set([
        "bir", "bu", "şu", "ve", "veya", "ile", "için",
        "nasıl", "nedir", "olan", "bana", "kod", "yaz",
        "yap", "yapar", "mi", "mı", "mu", "mü"
    ]);

    const words = normalizeText(query)
        .split(/\s+/)
        .filter((word) => word.length >= 3 && !ignored.has(word));

    if (words.length === 0) {
        return "";
    }

    return codeKnowledgeLines
        .map((line) => {
            const normalized = normalizeText(line);
            let score = 0;

            for (const word of words) {
                if (normalized.includes(word)) {
                    score += 1;
                }
            }

            return { line, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((item) => item.line)
        .join("\n")
        .slice(0, 3000);
}

function createSystemPrompt(knowledge) {
    let prompt = `
Sen Java AI'sın.
Kahve temalı, kısa ve doğrudan cevap veren bir yazılım asistanısın.

Uzmanlıkların:
- Java
- JavaScript
- TypeScript
- HTML ve CSS
- Node.js
- Hata ayıklama

Kurallar:
- Türkçe cevap ver.
- İstenen kodu doğrudan üret.
- Var olmayan paket veya API uydurma.
- Kod kısa değilse gerekli dosya adlarını belirt.
- Kullanıcının son mesajlarına göre bağlamı koru.
- Gereksiz uzun açıklama yapma.
- Bilmediğin konuda kesin konuşma.
`.trim();

    if (knowledge) {
        prompt += `

Aşağıdaki bilgi veri.txt içinden soruya göre seçildi:
--- BİLGİ ---
${knowledge}
--- BİLGİ SONU ---`;
    }

    return prompt;
}

function sanitizeHistory(history) {
    return history
        .filter(
            (message) =>
                message &&
                typeof message === "object" &&
                ["user", "assistant"].includes(message.role) &&
                typeof message.content === "string"
        )
        .map((message) => ({
            role: message.role,
            content: message.content.slice(0, 4000)
        }))
        .slice(-MAX_HISTORY_MESSAGES);
}

function getLastUserMessage(history) {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index].role === "user") {
            return history[index].content;
        }
    }

    return "";
}

// =================================
// llama-server
// =================================

function startLlamaServer() {
    if (llamaProcess || llamaStarting) {
        return;
    }

    if (!fs.existsSync(LLAMA_SERVER_PATH)) {
        lastLlamaError =
            `llama-server bulunamadı: ${LLAMA_SERVER_PATH}`;
        console.error(`❌ ${lastLlamaError}`);
        return;
    }

    llamaStarting = true;
    llamaReady = false;
    lastLlamaError = null;

    const args = [
        "-hf", MODEL_REFERENCE,
        "--host", LLAMA_HOST,
        "--port", String(LLAMA_PORT),
        "--ctx-size", String(LLAMA_CONTEXT_SIZE),
        "--threads", String(LLAMA_THREADS),
        "--threads-batch", String(LLAMA_THREADS),
        "--parallel", "1",
        "--batch-size", "32",
        "--ubatch-size", "16",
        "--no-mmap",
        "--mlock", "0"
    ];

    console.log("🦙 llama-server başlatılıyor...");
    console.log(`🤖 Model: ${MODEL_REFERENCE}`);

    llamaProcess = spawn(LLAMA_SERVER_PATH, args, {
        cwd: __dirname,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            LLAMA_CACHE:
                process.env.LLAMA_CACHE || "/tmp/llama-cache"
        }
    });

    llamaProcess.stdout.on("data", (data) => {
        const text = data.toString().trim();
        if (text) console.log(`[LLAMA] ${text}`);
    });

    llamaProcess.stderr.on("data", (data) => {
        const text = data.toString().trim();
        if (text) console.log(`[LLAMA] ${text}`);
    });

    llamaProcess.on("error", (error) => {
        lastLlamaError = error.message;
        llamaProcess = null;
        llamaReady = false;
        llamaStarting = false;
        console.error("❌ llama-server hatası:", error.message);
    });

    llamaProcess.on("close", (code, signal) => {
        lastLlamaError =
            `llama-server kapandı. kod=${code}, sinyal=${signal || "yok"}`;
        llamaProcess = null;
        llamaReady = false;
        llamaStarting = false;
        console.error(`⚠️ ${lastLlamaError}`);
    });

    waitForLlama()
        .then(() => {
            llamaReady = true;
            llamaStarting = false;
            console.log("✅ Yerel coder modeli hazır.");
        })
        .catch((error) => {
            lastLlamaError = error.message;
            llamaReady = false;
            llamaStarting = false;
            console.error("❌ Model hazır olmadı:", error.message);
        });
}

async function waitForLlama() {
    const attempts = 180;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetch(`${LLAMA_API_URL}/health`, {
                signal: AbortSignal.timeout(2500)
            });

            if (response.ok) {
                return;
            }
        } catch {
            // İndirme/yükleme devam ediyor olabilir.
        }

        if (attempt % 10 === 0) {
            console.log(`⏳ Model bekleniyor: ${attempt}/${attempts}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error("llama-server zamanında hazır olmadı.");
}

// =================================
// API
// =================================

app.get("/health", (_req, res) => {
    res.status(200).json({
        status: "ok",
        modelReady: llamaReady
    });
});

app.get("/api/status", (_req, res) => {
    res.json({
        server: "online",
        modelReady: llamaReady,
        modelStarting: llamaStarting,
        model: MODEL_REFERENCE,
        contextSize: LLAMA_CONTEXT_SIZE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        knowledgeLines: codeKnowledgeLines.length,
        lastError: lastLlamaError
    });
});

app.post("/api/chat", async (req, res) => {
    try {
        const history = req.body?.history;

        if (!Array.isArray(history) || history.length === 0) {
            return res.status(400).json({
                error: "Geçerli bir sohbet geçmişi gönderilmedi."
            });
        }

        if (!llamaReady) {
            return res.status(503).json({
                error: "Model henüz indiriliyor veya yükleniyor.",
                loading: true,
                details: lastLlamaError
            });
        }

        const recentHistory = sanitizeHistory(history);

        if (recentHistory.length === 0) {
            return res.status(400).json({
                error: "Geçerli kullanıcı mesajı bulunamadı."
            });
        }

        const lastUserMessage = getLastUserMessage(recentHistory);
        const knowledge = findRelevantKnowledge(lastUserMessage);

        const messages = [
            {
                role: "system",
                content: createSystemPrompt(knowledge)
            },
            ...recentHistory
        ];

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120000);

        let response;

        try {
            response = await fetch(
                `${LLAMA_API_URL}/v1/chat/completions`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: MODEL_REFERENCE,
                        messages,
                        temperature: 0.35,
                        top_p: 0.9,
                        max_tokens: MAX_OUTPUT_TOKENS,
                        stream: false
                    }),
                    signal: controller.signal
                }
            );
        } finally {
            clearTimeout(timer);
        }

        const raw = await response.text();
        let result;

        try {
            result = JSON.parse(raw);
        } catch {
            throw new Error(
                `llama-server JSON olmayan cevap verdi: ${raw.slice(0, 300)}`
            );
        }

        if (!response.ok) {
            throw new Error(
                result?.error?.message ||
                result?.error ||
                `HTTP ${response.status}`
            );
        }

        const reply =
            result?.choices?.[0]?.message?.content?.trim();

        if (!reply) {
            throw new Error("Model boş cevap döndürdü.");
        }

        return res.json({
            reply,
            local: true,
            model: MODEL_REFERENCE,
            usage: result.usage || null
        });
    } catch (error) {
        console.error("❌ Chat hatası:", error);

        if (error.name === "AbortError") {
            return res.status(504).json({
                error: "Model zaman aşımına uğradı."
            });
        }

        return res.status(500).json({
            error: "Yerel model cevap üretirken hata oluştu.",
            details: error.message
        });
    }
});

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
Durum            : Express hazır
========================================
`);

    startLlamaServer();
});

function shutdown(signal) {
    console.log(`🛑 ${signal} alındı.`);

    if (llamaProcess) {
        llamaProcess.kill("SIGTERM");
    }

    process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
