import { lookup as systemLookup } from "node:dns/promises"
import { isIP } from "node:net"
import { open, stat, unlink } from "node:fs/promises"
import { dirname, relative } from "node:path"
import type { AdapterResult, ParsedCommand } from "./types.js"
import { parseStrictObject, requireString } from "./parser.js"
import { resolveWorkspacePath } from "./paths.js"

const MAX_URL_LENGTH = 2_048
const MAX_EXTRACT_BYTES = 1_048_576
const MAX_EXTRACT_CHARS = 40_000
const MAX_DOWNLOAD_BYTES = 10 * 1_048_576
const REQUEST_TIMEOUT_MS = 10_000

export type WebRequest = { url: string; mode: "extract"; path?: never } | { url: string; mode: "download"; path: string }

export type WebDependencies = {
  fetch?: typeof fetch
  lookup?: typeof systemLookup
  timeoutMs?: number
}

export function parseWebRequest(command: ParsedCommand): WebRequest {
  const parsed = parseStrictObject(command, ["url", "mode", "path"])
  const url = requireString(parsed.url, "url")
  if (url.length > MAX_URL_LENGTH) throw new Error(`url must be at most ${MAX_URL_LENGTH} characters`)
  if (parsed.mode === "extract") {
    if (parsed.path !== undefined) throw new Error("web_discover extract does not accept path")
    return { url, mode: "extract" }
  }
  if (parsed.mode === "download") {
    return { url, mode: "download", path: requireString(parsed.path, "path") }
  }
  throw new Error("web_discover mode must be extract or download")
}

export async function validateWebPermission(
  command: ParsedCommand,
  root: string,
  dependencies: WebDependencies = {}
): Promise<string[]> {
  const request = parseWebRequest(command)
  const url = await validatePublicUrl(request.url, dependencies.lookup)
  if (request.mode === "extract") return [url.href]
  const destination = await resolveWorkspacePath(root, request.path)
  await assertNewDestination(destination)
  return [url.href, destination]
}

export async function executeWebDiscover(
  command: ParsedCommand,
  root: string,
  signal: AbortSignal,
  dependencies: WebDependencies = {}
): Promise<AdapterResult> {
  const request = parseWebRequest(command)
  const url = await validatePublicUrl(request.url, dependencies.lookup)
  // Re-resolve immediately before I/O to reject a changed public/private DNS answer.
  await assertPublicHost(url.hostname, dependencies.lookup)
  const timeout = AbortSignal.timeout(dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  const response = await (dependencies.fetch ?? fetch)(url, {
    method: "GET",
    redirect: "manual",
    signal: combined,
    credentials: "omit",
    headers: { accept: request.mode === "extract" ? "text/html, application/json, application/xml, text/plain" : "*/*" },
  })
  if (response.status >= 300 && response.status < 400) throw new Error("web_discover redirects are not followed")
  if (!response.ok) throw new Error(`web_discover request failed with HTTP ${response.status}`)

  if (request.mode === "extract") {
    assertContentLength(response, MAX_EXTRACT_BYTES)
    const bytes = await readResponseBounded(response, MAX_EXTRACT_BYTES)
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
    if (!isExtractable(contentType)) throw new Error(`web_discover cannot extract content type: ${contentType || "unknown"}`)
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    const output = contentType === "text/html" ? htmlToText(decoded) : decoded
    return {
      output: output.slice(0, MAX_EXTRACT_CHARS) || "No extractable text.",
      metadata: { url: url.href, mode: request.mode, contentType, bytes: bytes.byteLength, truncated: output.length > MAX_EXTRACT_CHARS },
    }
  }

  const destination = await resolveWorkspacePath(root, request.path)
  await assertNewDestination(destination)
  assertContentLength(response, MAX_DOWNLOAD_BYTES)
  let file: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    file = await open(destination, "wx")
    created = true
    const reader = response.body?.getReader()
    if (!reader) throw new Error("web_discover response has no body")
    let written = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      written += chunk.value.byteLength
      if (written > MAX_DOWNLOAD_BYTES) {
        await reader.cancel()
        throw new Error(`web_discover download exceeds ${MAX_DOWNLOAD_BYTES} bytes`)
      }
      await file.write(chunk.value)
    }
    await file.close()
    file = undefined
    const canonicalRoot = await resolveWorkspacePath(root, ".")
    return { output: `Downloaded ${written} bytes to ${relative(canonicalRoot, destination)}.`, metadata: { url: url.href, mode: request.mode, path: relative(canonicalRoot, destination), bytes: written } }
  } catch (error) {
    await file?.close().catch(() => undefined)
    if (created) await unlink(destination).catch(() => undefined)
    throw error
  }
}

async function validatePublicUrl(raw: string, lookup: WebDependencies["lookup"]): Promise<URL> {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error("url must be an absolute HTTP or HTTPS URL") }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url protocol must be http or https")
  if (url.username || url.password) throw new Error("url credentials are not allowed")
  if (url.hash) throw new Error("url fragments are not allowed")
  await assertPublicHost(url.hostname, lookup)
  return url
}

async function assertPublicHost(hostname: string, lookup: WebDependencies["lookup"]): Promise<void> {
  const normalized = hostname.toLowerCase().replace(/\.$/, "")
  const specialUse = ["localhost", "local", "internal", "home.arpa", "onion", "invalid", "test"]
  if (specialUse.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`))) {
    throw new Error("url host must be public")
  }
  if (isIP(normalized)) throw new Error("IP literal URL hosts are not allowed")
  const addresses = await (lookup ?? systemLookup)(normalized, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("url host resolved to a private or reserved address")
  }
}

function isPublicAddress(address: string): boolean {
  if (address.includes(":")) {
    const value = address.toLowerCase()
    return (value.startsWith("2") || value.startsWith("3")) && !value.startsWith("2001:db8:")
  }
  const octets = address.split(".").map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a = 0, b = 0] = octets
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) || (a === 192 && b === 88) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51) || (a === 203 && b === 0))
}

function assertContentLength(response: Response, maximum: number): void {
  const value = response.headers.get("content-length")
  if (value !== null && Number(value) > maximum) throw new Error(`web_discover response exceeds ${maximum} bytes`)
}

async function readResponseBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    length += chunk.value.byteLength
    if (length > maximum) {
      await reader.cancel()
      throw new Error(`web_discover response exceeds ${maximum} bytes`)
    }
    chunks.push(chunk.value)
  }
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

function isExtractable(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/xml" || contentType.endsWith("+json") || contentType.endsWith("+xml")
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
}

async function assertNewDestination(path: string): Promise<void> {
  try {
    await stat(path)
    throw new Error("web_discover download destination already exists")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  const parent = await stat(dirname(path))
  if (!parent.isDirectory()) throw new Error("web_discover download parent must be an existing directory")
}
