FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git openssh-client && \
    mkdir -p -m 755 /etc/apt/keyrings && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY runtime-worker/package.json runtime-worker/package.json
COPY bridge/package.json bridge/package.json
RUN npm install --prefix /app/runtime-worker && npm install --prefix /app/bridge
COPY runtime-worker runtime-worker
COPY bridge bridge
RUN /app/bridge/node_modules/.bin/tsc -p /app/bridge/tsconfig.json && /app/runtime-worker/node_modules/.bin/tsc -p /app/runtime-worker/tsconfig.json
WORKDIR /app/runtime-worker
ENV NODE_ENV=production ORLYNX_BRIDGE_BUNDLE=/app/bridge/dist/index.js
CMD ["node", "dist/index.js"]
