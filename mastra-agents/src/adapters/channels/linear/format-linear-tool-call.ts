import { fencedJson, fencedText, stripToolPrefix, summarizeForLinear, truncateText } from "./format-linear-shared.js";

type FormatToolCallInfo = {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  isError?: boolean;
};

const workspaceToolLabels: Record<string, string> = {
  list_files: "List files",
  read_file: "Read file",
  write_file: "Write file",
  edit_file: "Edit file",
  read_snapshots: "Read snapshots",
  git_snapshot_query: "Git snapshot query",
  capture_snapshot: "Capture snapshot",
};

function toolLabel(toolName: string) {
  const stripped = stripToolPrefix(toolName);
  return workspaceToolLabels[stripped] ?? stripped.replace(/[_-]+/g, " ");
}

function formatArgs(args: Record<string, unknown>) {
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return "";

  const summary = entries
    .slice(0, 5)
    .map(([key, value]) => `- ${key}: ${summarizeForLinear(value, 220)}`)
    .join("\n");

  const extra = entries.length > 5 ? `\n- ... ${entries.length - 5} more args` : "";
  return `\n\n**Input**\n${summary}${extra}`;
}

function formatResult(result: unknown, isError?: boolean) {
  if (result == null) return "\n\n**Result**\n(no result)";

  if (typeof result === "string") {
    const body = truncateText(result, isError ? 1200 : 1800);
    return `\n\n**${isError ? "Failure" : "Result"}**\n${fencedText(body, isError ? 1200 : 1800)}`;
  }

  if (typeof result === "object") {
    return `\n\n**${isError ? "Failure" : "Result"}**\n${fencedJson(result, isError ? 1200 : 1800)}`;
  }

  return `\n\n**${isError ? "Failure" : "Result"}**\n${fencedText(result)}`;
}

export function formatLinearToolCall(info: FormatToolCallInfo) {
  const status = info.isError ? "failed" : "completed";
  return [
    `### Tool ${status}: ${toolLabel(info.toolName)}`,
    formatArgs(info.args),
    formatResult(info.result, info.isError),
  ].join("");
}
