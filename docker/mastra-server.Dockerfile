# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    openssh-client \
    procps \
  && rm -rf /var/lib/apt/lists/*

# Copy package files first for layer caching
COPY mastra-agents/package.json /app/mastra-agents/package.json
COPY package.json /app/package.json
COPY package-lock.json /app/package-lock.json

WORKDIR /app
RUN npm ci

ARG MASTRA_ACP_TARBALL_URL=
ARG LINEAR_ACP_ADAPTER_TARBALL_URL=
RUN --mount=type=secret,id=github_token,required=false \
  fetch_tgz() { \
    url="$1"; \
    dest="$2"; \
    if [ -s /run/secrets/github_token ]; then \
      curl -fsSL \
        -H "Authorization: Bearer $(cat /run/secrets/github_token)" \
        -H "Accept: application/octet-stream" \
        "$url" \
        -o "$dest"; \
    else \
      curl -fsSL "$url" -o "$dest"; \
    fi; \
  }; \
  if [ -n "$MASTRA_ACP_TARBALL_URL" ]; then \
    fetch_tgz "$MASTRA_ACP_TARBALL_URL" /tmp/mastra-acp.tgz; \
    npm install -g /tmp/mastra-acp.tgz; \
    rm -f /tmp/mastra-acp.tgz; \
  fi; \
  if [ -n "$LINEAR_ACP_ADAPTER_TARBALL_URL" ]; then \
    fetch_tgz "$LINEAR_ACP_ADAPTER_TARBALL_URL" /tmp/linear-acp-adapter.tgz; \
    npm install -g /tmp/linear-acp-adapter.tgz; \
    rm -f /tmp/linear-acp-adapter.tgz; \
  fi

COPY mastra-agents /app/mastra-agents
COPY mastra-code /app/mastra-code
COPY paseo /app/paseo
COPY docker/bundled-entrypoint.sh /usr/local/bin/mastra-bundled-entrypoint

WORKDIR /app/mastra-agents
RUN npm run build
RUN chmod +x /usr/local/bin/mastra-bundled-entrypoint \
  && mkdir -p /data/linear-acp /etc/linear-acp

ENV NODE_ENV=production
ENV MASTRA_SERVER_HOST=0.0.0.0
ENV MASTRA_SERVER_PORT=4111
ENV DATABASE_URL=postgresql://mastra:mastra@mastra-postgres:5432/mastra
ENV MASTRA_WORKSPACE_SANDBOX=docker
ENV LINEAR_ACP_ADAPTER_ENABLED=true
ENV LINEAR_ACP_ADAPTER_HOST=0.0.0.0
ENV LINEAR_ACP_ADAPTER_PORT=8080
ENV LINEAR_ACP_ADAPTER_STATE_BACKEND=sqlite
ENV LINEAR_ACP_ADAPTER_SQLITE_FILE=/data/linear-acp/state.sqlite
ENV LINEAR_ACP_ADAPTER_CONFIG_FILE=/etc/linear-acp/config.yaml
ENV LINEAR_ACP_ADAPTER_ACP_COMMAND=mastra-acp
ENV LINEAR_ACP_ADAPTER_ACP_CWD=/app
ENV LINEAR_ACP_ADAPTER_MASTRA_BASE_URL=http://127.0.0.1:4111
ENV DISABLE_NATIVE_LINEAR_CHANNEL_WHEN_LINEAR_ACP=true

EXPOSE 4111
EXPOSE 8080

CMD ["mastra-bundled-entrypoint"]
