# syntax=docker/dockerfile:1

# ==========================================
# 1) llama.cpp derle
# ==========================================
FROM node:22-bookworm-slim AS llama-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    cmake \
    build-essential \
    ca-certificates \
    libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Çalıştığı bilinen sürümü indir
RUN git clone --depth 1 --branch b5614 https://github.com/ggml-org/llama.cpp.git

WORKDIR /build/llama.cpp

RUN cmake -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_NATIVE=OFF \
    -DGGML_OPENMP=OFF \
    -DGGML_BLAS=OFF \
    -DGGML_CUDA=OFF \
    -DGGML_VULKAN=OFF \
    -DBUILD_SHARED_LIBS=OFF

RUN cmake --build build --config Release --target llama-server -j2

RUN test -f build/bin/llama-server


# ==========================================
# 2) Node
# ==========================================
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libcurl4 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

COPY --from=llama-builder \
    /build/llama.cpp/build/bin/llama-server \
    /usr/local/bin/llama-server

RUN chmod +x /usr/local/bin/llama-server \
    && mkdir -p /tmp/llama-cache

ENV NODE_ENV=production
ENV LLAMA_SERVER_PATH=/usr/local/bin/llama-server
ENV LLAMA_CACHE=/tmp/llama-cache

ENV MODEL_REPOSITORY=mradermacher/SolaraV2-coder-GGUF
ENV MODEL_QUANT=Q2_K

ENV LLAMA_CONTEXT_SIZE=512
ENV LLAMA_THREADS=1
ENV MAX_OUTPUT_TOKENS=128
ENV MAX_HISTORY_MESSAGES=4

EXPOSE 10000

CMD ["node","server.js"]