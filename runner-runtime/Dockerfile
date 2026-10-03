FROM node:24-bookworm-slim AS bridge-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
COPY bridge/package.json bridge/tsconfig.json ./bridge/
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY runtime-worker/package.json ./runtime-worker/
RUN npm ci --workspace=@orlynx/bridge --include-workspace-root=false --no-audit --no-fund
COPY bridge/src ./bridge/src
RUN npm run build --workspace=@orlynx/bridge && npm prune --omit=dev --workspace=@orlynx/bridge

FROM node:24-bookworm-slim
ARG TARGETARCH
ARG INSTALL_MINI_SWE=true
ARG OPENCODE_VERSION=1.18.32
ARG PLAYWRIGHT_VERSION=1.63.0
ENV OPENCODE_VERSION=${OPENCODE_VERSION}
ENV PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION}
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git curl psmisc iproute2 ripgrep python3 python3-pip python3-venv make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

RUN useradd --create-home --uid 10001 --shell /bin/bash orlynx \
    && mkdir -p /workspace /opt/orlynx/bridge /opt/orlynx/opencode /opt/orlynx/playwright /opt/orlynx/bin /ms-playwright \
    && chown -R orlynx:orlynx /workspace /opt/orlynx /ms-playwright

COPY --from=bridge-build --chown=orlynx:orlynx /src/bridge/dist /opt/orlynx/bridge
COPY --from=bridge-build --chown=orlynx:orlynx /src/node_modules /opt/orlynx/bridge/node_modules
COPY --chown=orlynx:orlynx runner-runtime/start-bridge.sh /opt/orlynx/start-bridge.sh
COPY --chown=orlynx:orlynx runner-runtime/preview-proxy.mjs /opt/orlynx/preview-proxy.mjs
COPY --chown=orlynx:orlynx runner-runtime/browser-smoke.mjs /opt/orlynx/browser-smoke.mjs

# Browser/E2E capability is part of the runtime image, not a per-task repair.
# Playwright installs the exact Debian libraries Chromium needs plus a shared
# browser cache that every workspace container can reuse.
RUN npm install --prefix /opt/orlynx/playwright --no-save --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}" \
    && /opt/orlynx/playwright/node_modules/.bin/playwright install --with-deps chromium \
    && chmod -R a+rX /opt/orlynx/playwright /ms-playwright

RUN chmod +x /opt/orlynx/start-bridge.sh \
    && case "$TARGETARCH" in \
         amd64|"") pkg="opencode-linux-x64-baseline" ;; \
         arm64) pkg="opencode-linux-arm64" ;; \
         *) echo "Unsupported runner architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && npm install --prefix /opt/orlynx/opencode --no-save --omit=dev --no-audit --no-fund "$pkg@$OPENCODE_VERSION" \
    && ln -s "/opt/orlynx/opencode/node_modules/$pkg/bin/opencode" /opt/orlynx/bin/opencode \
    && /opt/orlynx/bin/opencode --version

# mini-SWE is pinned in the image; local/free endpoint
# configuration remains operator-owned and is never baked into an image.
RUN if [ "$INSTALL_MINI_SWE" = "true" ]; then python3 -m venv /opt/orlynx/mini-swe \
      && /opt/orlynx/mini-swe/bin/pip install --disable-pip-version-check 'mini-swe-agent==2.4.6'; fi
USER orlynx
WORKDIR /workspace
ENV ORLYNX_PREVIEW_PROXY_PORT=4108
CMD ["node", "/opt/orlynx/preview-proxy.mjs"]
