# Java AI Local Coder — Render

Bu proje Groq kullanmaz. Docker build sırasında `llama.cpp` klonlanır ve yalnızca
`llama-server` derlenir. Uygulama açılırken aşağıdaki küçük coder GGUF modeli
Hugging Face üzerinden otomatik indirilir:

- Repo: `mradermacher/SolaraV2-coder-GGUF`
- Quant: `Q2_K`
- Taban: SmolLM2-360M
- GGUF boyutu: yaklaşık 219 MB

## Render'a kurulum

### En temiz yöntem

1. Bu dosyaları GitHub deposunun köküne koy.
2. Render'da mevcut Native Node servisini sil veya yeni servis oluştur.
3. `New +` → `Blueprint` seç.
4. GitHub deposunu seç.
5. Render, kökteki `render.yaml` ve `Dockerfile` dosyasını kullanır.

Logda `Running build command 'npm install'` görürsen servis hâlâ Native Node'dur.
Doğru Docker build logunda `FROM`, `cmake`, `git clone` ve `llama-server`
derleme adımları görünür.

## API

### Durum

`GET /api/status`

### Sohbet

`POST /api/chat`

```json
{
  "history": [
    {
      "role": "user",
      "content": "JavaScript ile merhaba dünya yaz."
    }
  ]
}
```

## Bellek sorunu olursa

Render Environment bölümünde:

```text
LLAMA_CONTEXT_SIZE=512
MAX_OUTPUT_TOKENS=128
MAX_HISTORY_MESSAGES=4
LLAMA_THREADS=1
```

360M model çok küçük olduğu için büyük projelerde doğru sonuç garantisi yoktur.
Ayrıca Render'ın dosya sistemi kalıcı olmadığı için servis yeniden kurulursa model
yeniden indirilebilir.
