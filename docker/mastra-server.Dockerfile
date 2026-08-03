# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN npm run typecheck && npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV MASTRA_SERVER_HOST=0.0.0.0
ENV MASTRA_SERVER_PORT=4111
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/.mastra ./.mastra
EXPOSE 4111
CMD ["npx", "mastra", "start"]
