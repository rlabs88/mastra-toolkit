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

COPY mastra-agents /app/mastra-agents
COPY mastra-code /app/mastra-code
COPY paseo /app/paseo

ENV MASTRA_WORKSPACE_ROOT=/app
ENV MASTRA_WORKSPACE_FILESYSTEM_ROOT=/app
ENV MASTRA_WORKSPACE_MOUNT_ROOT=/workspace
ENV MASTRA_WORKSPACE_ACCESS_ROOTS=/app,/root,/container,/shared
ENV MASTRA_DOCKER_SANDBOX_HOST_WORKSPACE_ROOT=/container/shared/workspace/projects/mastra-system

WORKDIR /app/mastra-agents
RUN npm run build

ENV NODE_ENV=production
ENV MASTRA_SERVER_HOST=0.0.0.0
ENV MASTRA_SERVER_PORT=4111
ENV DATABASE_URL=postgresql://mastra:mastra@mastra-postgres:5432/mastra
ENV MASTRA_WORKSPACE_SANDBOX=docker

EXPOSE 4111

CMD ["npm", "run", "start", "--", "--dir", ".mastra/output"]
