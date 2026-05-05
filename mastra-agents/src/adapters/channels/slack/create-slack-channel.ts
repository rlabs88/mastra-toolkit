import { createSlackAdapter } from "@chat-adapter/slack";

export function createSlackChannel() {
  return createSlackAdapter();
}
