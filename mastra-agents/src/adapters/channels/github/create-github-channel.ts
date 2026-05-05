import { createGitHubAdapter } from "@chat-adapter/github";

export function createGitHubChannel() {
  return createGitHubAdapter();
}
