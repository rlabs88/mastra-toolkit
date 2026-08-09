#!/usr/bin/env node
import { register } from "tsx/esm/api";

register();

try {
  await import("../src/mz-cli.ts");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
