import { z } from "zod";

export const SANDBOX_RUNTIME_IMAGE_ENV = "MASTRA_TOOLKIT_RUNTIME_IMAGE";

export const immutableSandboxImageSchema = z.string().regex(
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/,
  "Sandbox image must use an immutable sha256 digest",
);
