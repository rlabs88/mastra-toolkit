import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function validateProjectMcpConfiguration(
  projectRoot: string,
  userHome: string = homedir(),
): Promise<void> {
  const files = [
    join(projectRoot, ".claude", "settings.local.json"),
    join(userHome, ".mastracode", "mcp.json"),
    join(projectRoot, ".mcp.json"),
    join(projectRoot, ".mastracode", "mcp.json"),
  ];
  for (const file of files) await validateJsonFile(file);
}

export const validateMcpConfigFiles = validateProjectMcpConfiguration;

async function validateJsonFile(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  try {
    JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid MCP JSON: ${path}`, { cause: error });
  }
}
