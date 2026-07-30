FROM node:20-bookworm-slim AS llama-builder

RUN apt-get update && apt-get install -y \
    git \
    cmake \
    build-essential \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN git clone --depth 1 \
    https://github.com/ggml-org/llama.cpp.git

WORKDIR /build/llama.cpp

# CPU için statik ve olabildiğince küçük build.
# Yalnızca llama-server derlenir.
RUN cmake -S . -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_SERVER=ON \
    && cmake --build build \
    --config Release \
    --target llama-server \
    -j 2


FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev \
    && npm cache clean --force

COPY server.js ./
COPY public ./public

# veri.txt mevcut değilse Docker build bozulmasın.
COPY veri.txt* ./

COPY --from=llama-builder \
    /build/llama.cpp/build/bin/llama-server \
    /app/llama.cpp/build/bin/llama-server

RUN chmod +x \
    /app/llama.cpp/build/bin/llama-server

RUN mkdir -p /app/.llama-cache

ENV NODE_ENV=production
ENV LLAMA_SERVER_PATH=/app/llama.cpp/build/bin/llama-server
ENV LLAMA_CACHE=/app/.llama-cache
ENV MODEL_REPOSITORY=mradermacher/SolaraV2-coder-GGUF
ENV MODEL_QUANT=Q2_K
ENV LLAMA_CONTEXT_SIZE=1024
ENV LLAMA_THREADS=2
ENV MAX_OUTPUT_TOKENS=256
ENV MAX_HISTORY_MESSAGES=8

EXPOSE 3000

CMD ["node", "server.js"]