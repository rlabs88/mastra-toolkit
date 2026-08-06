import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LibSQLFactoryStorage } from "@mastra/libsql";
import { PgFactoryStorage, PgVector } from "@mastra/pg";

export function createFactoryStorage(databaseUrl?: string) {
  if (databaseUrl) {
    const factoryStorage = new PgFactoryStorage({
      id: "mastra-toolkit-storage",
      connectionString: databaseUrl,
    });
    return {
      factoryStorage,
      storage: factoryStorage.getMastraStorage(),
      vector: new PgVector({ id: "mastra-toolkit-vectors", connectionString: databaseUrl }),
    };
  }
  const dataDirectory = process.env.MASTRA_APP_DATA_DIR
    ?? join(homedir(), ".mastra-toolkit", "data");
  const databasePath = join(dataDirectory, "factory.db");
  mkdirSync(dirname(databasePath), { recursive: true });
  const factoryStorage = new LibSQLFactoryStorage({
    id: "mastra-toolkit-storage",
    url: `file:${databasePath}`,
  });
  return { factoryStorage, storage: factoryStorage.getMastraStorage(), vector: undefined };
}
