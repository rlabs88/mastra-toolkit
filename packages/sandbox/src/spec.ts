import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const DEFAULT_SANDBOX_SPEC_PATH = fileURLToPath(
  new URL("../config/sandbox.config.json", import.meta.url),
);

const immutableImageSchema = z.string().regex(
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/,
  "Docker image must use an immutable sha256 digest",
);

const sandboxSpecSchema = z.object({
  $schema: z.string().optional(),
  apiVersion: z.literal("cortex.provisioning/v1"),
  kind: z.literal("SandboxRuntime"),
  metadata: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    displayName: z.string().min(1),
    version: z.number().int().positive(),
  }).strict(),
  spec: z.object({
    defaultProvider: z.enum(["local", "docker", "platform"]),
    commandTimeoutMs: z.number().int().positive(),
    maxSandboxes: z.number().int().positive(),
    workdir: z.string().startsWith("/"),
    entrypointProfile: z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      image: immutableImageSchema,
      platform: z.literal("linux/arm64"),
      abi: z.literal("sandbox-entrypoint/v1"),
      command: z.tuple([z.literal("serve")]),
      probeCommand: z.tuple([z.literal("probe")]),
    }).strict(),
    local: z.object({
      isolation: z.enum(["auto", "none", "seatbelt", "bwrap"]),
      allowNetwork: z.boolean(),
      allowSystemBinaries: z.boolean(),
      readOnly: z.boolean(),
      readOnlyPaths: z.array(z.string()),
      readWritePaths: z.array(z.string()),
    }).strict(),
    docker: z.object({
      readonlyRootfs: z.boolean(),
      capDrop: z.array(z.string()),
      securityOpt: z.array(z.string()),
      pidsLimit: z.number().int().positive(),
      memoryBytes: z.number().int().positive(),
      tmpfs: z.record(z.string(), z.string()),
    }).strict(),
    platform: z.object({
      networkIsolation: z.enum(["ISOLATED", "PRIVATE"]),
      idleTimeoutMinutes: z.number().int().positive(),
    }).strict(),
  }).strict(),
}).strict();

export type SandboxSpec = z.infer<typeof sandboxSpecSchema>;
export type SandboxProvider = SandboxSpec["spec"]["defaultProvider"];

export function parseSandboxSpec(input: unknown): SandboxSpec {
  return sandboxSpecSchema.parse(input);
}

export function findSandboxSpecPath(explicitPath?: string, startDirectory = process.cwd()): string {
  if (explicitPath) {
    return isAbsolute(explicitPath) ? explicitPath : resolve(startDirectory, explicitPath);
  }
  return DEFAULT_SANDBOX_SPEC_PATH;
}

export function loadSandboxSpec(path: string): SandboxSpec {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read sandbox specification at ${path}`, { cause: error });
  }
  return parseSandboxSpec(input);
}
