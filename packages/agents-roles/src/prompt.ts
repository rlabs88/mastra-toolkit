import { baseIdentity } from "./prompts/base-identity.js";
import { baseTask } from "./prompts/base-task.js";
import { sharedSecurity } from "./prompts/security.js";

export const PROMPT_SECTION_HEADINGS = [
  "Base Identity",
  "Role Identity",
  "Shared Security",
  "Role Security Additions",
  "Base Task Behavior",
  "Role Task Behavior",
] as const;

export interface RolePrompt {
  readonly baseIdentity?: string;
  readonly identity: string;
  readonly sharedSecurity?: string;
  readonly security: readonly string[];
  readonly baseTask?: string;
  readonly task: string;
}

export interface PromptRole {
  readonly prompts: RolePrompt;
}

export function composePrompt(role: PromptRole): string {
  const prompt = role.prompts;
  const roleSecurity = prompt.security.length === 0
    ? "No role-specific security additions."
    : prompt.security.map(addition => `- ${addition}`).join("\n");

  return [
    section(PROMPT_SECTION_HEADINGS[0], prompt.baseIdentity ?? baseIdentity),
    section(PROMPT_SECTION_HEADINGS[1], prompt.identity),
    section(PROMPT_SECTION_HEADINGS[2], prompt.sharedSecurity ?? sharedSecurity),
    section(PROMPT_SECTION_HEADINGS[3], roleSecurity),
    section(PROMPT_SECTION_HEADINGS[4], prompt.baseTask ?? baseTask),
    section(PROMPT_SECTION_HEADINGS[5], prompt.task),
  ].join("\n\n") + "\n";
}

function section(title: string, content: string): string {
  return `# ${title}\n\n${content.trim()}`;
}
