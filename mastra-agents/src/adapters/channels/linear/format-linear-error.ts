import { truncateText } from "./format-linear-shared.js";

export function formatLinearError(error: Error) {
  const message = truncateText(error.message || "Unknown error", 700);
  return `### Error\n\n${message}`;
}
