# syntax=docker/dockerfile:1

# ==========================================
# 1) llama.cpp: yalnızca llama-server derle
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

RUN git clone --depth 1 https://github.com/ggml-org/llama.cpp.git

WORKDIR /build/llama.cpp

RUN cmake -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_NATIVE=OFF \
    -DGGML_OPENMP=OFF \
    -DGGML_BLAS=OFF \
    -DGGML_CUDA=OFF \
    -DGGML_VULKAN=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_SERVER=ON \
    -DLLAMA_BUILD_TOOLS=OFF \
    -DLLAMA_BUILD_UI=OFF \
    -DLLAMA_CURL=ON \
    -DBUILD_SHARED_LIBS=OFF \
    && cmake --build build --config Release \
       --target llama-server -j 2

RUN test -x /build/llama.cpp/build/bin/llama-server


# ==========================================
# 2) Node uygulaması
# ==========================================
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libcurl4 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public
COPY veri.txt* ./

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
ENV LLAMA_CONTEXT_SIZE=768
ENV LLAMA_THREADS=1
ENV MAX_OUTPUT_TOKENS=192
ENV MAX_HISTORY_MESSAGES=6

EXPOSE 10000

CMD ["node", "server.js"]
