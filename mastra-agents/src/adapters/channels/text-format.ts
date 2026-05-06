const defaultStringLimit = 1800;
const defaultSummaryLimit = 240;

export function stripToolPrefix(toolName: string) {
  return toolName.replace(/^(workspaceTools\.|workspace\.|tools\.)/, "");
}

export function truncateChannelText(value: string, limit = defaultStringLimit) {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 48))}\n\n[truncated ${value.length - limit} chars]`;
}

export function stringifyForChannel(value: unknown, limit = defaultStringLimit) {
  if (typeof value === "string") return truncateChannelText(value, limit);
  if (value == null) return String(value);

  try {
    return truncateChannelText(JSON.stringify(value, null, 2), limit);
  } catch {
    return truncateChannelText(String(value), limit);
  }
}

export function summarizeForChannel(value: unknown, limit = defaultSummaryLimit) {
  const text = stringifyForChannel(value, limit).replace(/\s+/g, " ").trim();
  return text || "(empty)";
}

export function fencedChannelJson(value: unknown, limit = defaultStringLimit) {
  return `\`\`\`json\n${stringifyForChannel(value, limit)}\n\`\`\``;
}

export function fencedChannelText(value: unknown, limit = defaultStringLimit) {
  return `\`\`\`txt\n${stringifyForChannel(value, limit)}\n\`\`\``;
}
