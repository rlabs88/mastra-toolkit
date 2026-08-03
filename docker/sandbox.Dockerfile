# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash ca-certificates curl file git jq openssh-client poppler-utils procps ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 toolkit
WORKDIR /workspace
USER toolkit
CMD ["sleep", "infinity"]
