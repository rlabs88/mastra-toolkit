import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LibSQLFactoryStorage } from "@mastra/libsql";
import { PgFactoryStorage, PgVector } from "@mastra/pg";

export function createFactoryStorage(databaseUrl?: string, localDatabasePath?: string) {
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
  if (!localDatabasePath) throw new Error("Local Factory storage requires a resolved database path");
  const databasePath = localDatabasePath;
  mkdirSync(dirname(databasePath), { recursive: true });
  const factoryStorage = new LibSQLFactoryStorage({
    id: "mastra-toolkit-storage",
    url: `file:${databasePath}`,
  });
  return { factoryStorage, storage: factoryStorage.getMastraStorage(), vector: undefined };
}
