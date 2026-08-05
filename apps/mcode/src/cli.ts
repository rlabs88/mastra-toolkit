#!/usr/bin/env node
import { createLocalMcodeRuntime } from "@rlabs/mcode";

async function main(): Promise<void> {
  const runtime = await createLocalMcodeRuntime();
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
