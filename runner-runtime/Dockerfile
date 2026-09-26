FROM node:24-bookworm-slim AS bridge-build
WORKDIR /src/bridge
COPY bridge/package.json bridge/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY bridge/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ARG TARGETARCH
ARG OPENCODE_VERSION=1.18.32
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git curl psmisc python3 python3-pip make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

RUN useradd --create-home --uid 10001 --shell /bin/bash orlynx \
    && mkdir -p /workspace /opt/orlynx/bridge /opt/orlynx/opencode /opt/orlynx/bin \
    && chown -R orlynx:orlynx /workspace /opt/orlynx

COPY --from=bridge-build --chown=orlynx:orlynx /src/bridge/dist /opt/orlynx/bridge
COPY --from=bridge-build --chown=orlynx:orlynx /src/bridge/node_modules /opt/orlynx/bridge/node_modules
COPY --chown=orlynx:orlynx runner-runtime/start-bridge.sh /opt/orlynx/start-bridge.sh
RUN chmod +x /opt/orlynx/start-bridge.sh \
    && case "$TARGETARCH" in \
         amd64|"") pkg="opencode-linux-x64-baseline" ;; \
         arm64) pkg="opencode-linux-arm64" ;; \
         *) echo "Unsupported runner architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && npm install --prefix /opt/orlynx/opencode --no-save --omit=dev --no-audit --no-fund "$pkg@$OPENCODE_VERSION" \
    && ln -s "/opt/orlynx/opencode/node_modules/$pkg/bin/opencode" /opt/orlynx/bin/opencode \
    && /opt/orlynx/bin/opencode --version

USER orlynx
WORKDIR /workspace
CMD ["sleep", "infinity"]
