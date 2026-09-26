FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker.io ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY runner-manager/index.mjs ./index.mjs
ENV NODE_ENV=production PORT=8080
CMD ["node", "index.mjs"]
