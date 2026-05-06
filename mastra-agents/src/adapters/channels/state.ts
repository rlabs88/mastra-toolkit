import { createPostgresState } from "@chat-adapter/state-pg";

const defaultPostgresUrl = "postgresql://mastra:mastra@mastra-postgres:5432/mastra";

export function createChannelState() {
  return createPostgresState({
    url: process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? defaultPostgresUrl,
    keyPrefix: process.env.MASTRA_CHANNEL_STATE_PREFIX ?? "mastra-agents-channels",
  });
}
