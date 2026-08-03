import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import { parseStrictObject, requireString } from "./parser.js";
import { resolveWorkspacePath } from "./paths.js";
import type { AdapterResult, ParsedCommand } from "./types.js";

const MAX_MEDIA_BYTES = 8 * 1_048_576;
const MAX_TEXT_BYTES = 1_048_576;
const MAX_TEXT_CHARS = 40_000;

export function parseMediaRequest(command: ParsedCommand): { path: string; offset: number; limit: number } {
  const parsed = parseStrictObject(command, ["path", "offset", "limit"]);
  return {
    path: requireString(parsed.path, "path"),
    offset: integer(parsed.offset, "offset", 0, 1_000_000) ?? 0,
    limit: integer(parsed.limit, "limit", 1, 2_000) ?? 500,
  };
}

export async function executeReadMedia(command: ParsedCommand, root: string): Promise<AdapterResult> {
  const request = parseMediaRequest(command);
  const path = await resolveWorkspacePath(root, request.path);
  const canonicalRoot = await resolveWorkspacePath(root, ".");
  const info = await stat(path);
  if (info.isDirectory()) {
    const entries = (await readdir(path, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(request.offset, request.offset + Math.min(request.limit, 500))
      .map(entry => `${entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?"}\t${entry.name}`);
    return { output: entries.join("\n") || "Directory is empty.", metadata: { path: relative(canonicalRoot, path), kind: "directory", entries: entries.length } };
  }
  if (!info.isFile()) throw new Error("read_media path must be a regular file or directory");
  if (info.size > MAX_MEDIA_BYTES) throw new Error(`read_media file exceeds ${MAX_MEDIA_BYTES} bytes`);
  const header = await readPrefix(path, Math.min(info.size, 8_192));
  const mime = detectMime(header);
  if (mime) {
    const bytes = await readFile(path);
    return {
      output: `Attached ${relative(canonicalRoot, path)} (${mime}, ${bytes.byteLength} bytes).`,
      metadata: { path: relative(canonicalRoot, path), kind: "attachment", mime, bytes: bytes.byteLength },
      attachments: [{ type: "file", mime, url: `data:${mime};base64,${bytes.toString("base64")}`, filename: basename(path), byteLength: bytes.byteLength }],
    };
  }
  if (header.includes(0) || /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(new TextDecoder().decode(header))) {
    throw new Error("read_media does not support this binary, SVG, or video format");
  }
  if (info.size > MAX_TEXT_BYTES) throw new Error(`read_media text file exceeds ${MAX_TEXT_BYTES} bytes`);
  const text = await readFile(path, "utf8");
  const output = text.split("\n").slice(request.offset, request.offset + request.limit).join("\n");
  return { output: output.slice(0, MAX_TEXT_CHARS), metadata: { path: relative(canonicalRoot, path), kind: "text", truncated: output.length > MAX_TEXT_CHARS } };
}

function detectMime(header: Uint8Array): string | undefined {
  if (matches(header, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matches(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  const ascii = new TextDecoder().decode(header);
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (ascii.startsWith("%PDF-")) return "application/pdf";
  return undefined;
}

function matches(value: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => value[index] === byte);
}

async function readPrefix(path: string, length: number): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}
