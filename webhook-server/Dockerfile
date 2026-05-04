FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
ENV WEBHOOK_SERVER_HOST=0.0.0.0
ENV WEBHOOK_SERVER_PORT=8080
ENV MASTRA_UPSTREAM_URL=http://host.docker.internal:4111

COPY webhook-server/server.mjs ./server.mjs

EXPOSE 8080

CMD ["node", "server.mjs"]
