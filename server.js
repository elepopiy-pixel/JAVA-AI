const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const { Groq } = require("groq-sdk");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// =================================
// ⚙️ AYARLAR VE MİDDLEWARE
// =================================

app.use(cors());
// JSON limitini artırıyoruz çünkü geçmiş (history) verisi uzun olabilir
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, "public")));

// =================================
// 📄 VERİ.TXT OKUMA (KOD VERİ TABANI)
// =================================

let codeKnowledgeBase = "";
try {
    const veriPath = path.join(__dirname, "veri.txt");
    if (fs.existsSync(veriPath)) {
        codeKnowledgeBase = fs.readFileSync(veriPath, "utf-8");
        console.log("📄 [BAŞARILI] veri.txt okundu ve model hafızasına yüklendi.");
    } else {
        console.warn("⚠️ [UYARI] veri.txt dosyası bulunamadı! Ek bilgi olmadan başlatılıyor.");
    }
} catch (err) {
    console.error("❌ [HATA] veri.txt okunurken sorun oluştu:", err.message);
}

// =================================
// ☕ GROQ KEY HAVUZU & CLIENT POOL
// =================================

const groqKeys = Object.keys(process.env)
    .filter(key => key.startsWith("GROQ_API_"))
    .map(key => process.env[key])
    .filter(Boolean);

if (groqKeys.length === 0) {
    console.error("❌ [KRİTİK HATA] Groq API key bulunamadı! Lütfen .env dosyanızı kontrol edin.");
    process.exit(1);
}

const groqClients = groqKeys.map(key => new Groq({ apiKey: key }));
console.log(`☕ [BİLGİ] ${groqClients.length} adet Groq API key havuzu aktif.`);

let currentClientIndex = 0;

// =================================
// ☕ JAVA AI KİŞİLİĞİ VE SİSTEM PROMPTU
// =================================

const baseSystemPrompt = `
Sen Java AI'sın. ☕

Sen kahve temalı, hiper zeki ve profesyonel bir yazılım yapay zekasısın.
Kullanıcıyla önceki mesajlarını hatırlar, bağlamı koparmazsın.

Uzmanlık alanların:
- Java, JavaScript, TypeScript, Node.js, React, Spring Boot
- Backend geliştirme, Algoritmalar, Yazılım mimarisi, Debugging

Kurallar:
- Sana aşağıda verilen kod veri tabanındaki (veri.txt) örnekleri öncelikli referans olarak kullan.
- Temiz, modern ve doğru kod yaz. Hataları ve mantığı açıkla.
- Soru sorulduğunda veya bir fikir sunduğunda, kullanıcıdan onay almayı bekle. 
- "Bunu entegre edelim mi?" gibi sorular sorarak etkileşimli ilerle.
- Enerjik, yardımsever ve kahve seven bir uzmansın.

${codeKnowledgeBase ? `\n--- KOD VERİ TABANI (REFERANS) ---\n${codeKnowledgeBase}\n-------------------------------------------\n` : ""}
`;

// =================================
// 🤖 CHAT API (GEÇMİŞ DESTEKLİ OMEGA SÜRÜMÜ)
// =================================

app.post("/api/chat", async (req, res) => {
    const { history } = req.body;

    // Hata Kontrolü: Frontend geçerli bir history dizisi göndermezse reddet
    if (!history || !Array.isArray(history) || history.length === 0) {
        return res.status(400).json({ error: "Geçerli bir sohbet geçmişi gönderilmedi." });
    }

    // Context Limitini Korumak: Sadece son 15 mesajı al
    const recentHistory = history.slice(-15);

    // Mesaj Formatını Groq İçin Hazırlama
    const messagesForGroq = [
        { role: "system", content: baseSystemPrompt },
        ...recentHistory
    ];

    let lastError = null;
    const startIndex = currentClientIndex;
    
    // Yük dengeleme (Load Balancing) için index'i kaydır
    currentClientIndex = (currentClientIndex + 1) % groqClients.length;

    // Key havuzunu döngüyle dene (Biri patlarsa diğerine geçer)
    for (let i = 0; i < groqClients.length; i++) {
        const clientIndex = (startIndex + i) % groqClients.length;
        const groq = groqClients[clientIndex];

        try {
            const completion = await groq.chat.completions.create({
                messages: messagesForGroq,
                model: "llama-3.3-70b-versatile",
                temperature: 0.7,
                max_tokens: 4000 // Kod yazacağı için limit yüksek tutuldu
            });

            const reply = completion.choices[0]?.message?.content || "Cevap alınamadı.";
            return res.json({ reply: reply });

        } catch (error) {
            lastError = error;
            console.warn(`⚠️ [Key ${clientIndex + 1}] Hata verdi, sonraki key deneniyor... (${error.message})`);
        }
    }

    // Bütün key'ler tükenirse 500 dön
    return res.status(500).json({
        error: "Tüm API anahtarları limit aşımı yaptı veya yanıt vermiyor.",
        details: lastError?.message
    });
});

// =================================
// 🚀 SERVER BAŞLATMA
// =================================

app.listen(PORT, () => {
    console.log(`
======================================
      ☕ JAVA AI - OMEGA SÜRÜMÜ
======================================
Sunucu Adresi: http://localhost:${PORT}
Aktif Key Sayısı: ${groqClients.length}
Hafıza (Context): Aktif ✅
Kod Veri Tabanı Durumu: ${codeKnowledgeBase ? "Yüklendi 📄" : "Yok ⚠️"}
Durum: Hazır 🚀
======================================
    `);
});