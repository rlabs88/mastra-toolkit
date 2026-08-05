#!/usr/bin/env node
import { createLocalCodeRuntime } from "./local-runtime.js";

async function main(): Promise<void> {
  const runtime = await createLocalCodeRuntime();
  try {
    await runtime.runTui();
  } finally {
    await runtime.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
