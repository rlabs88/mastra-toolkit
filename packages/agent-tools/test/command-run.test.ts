import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  executeAdapter,
  executionClass,
  parseCommands,
  resolveWorkspacePath,
  runCommandSchedule,
} from "../src/index.js";

describe("command_run", () => {
  test("validates batch bounds, steps, and timeouts", () => {
    expect(() => parseCommands([])).toThrow(/between 1 and 20/);
    expect(() => parseCommands([{ command_type: "read", command_line: "{}", step: 0 }])).toThrow(/positive integer/);
    expect(() => parseCommands([{ command_type: "read", command_line: "{}", step: 1, timeout_ms: 99 }])).toThrow(/100/);
  });

  test("runs reads concurrently and mutations serially", async () => {
    const commands = parseCommands([
      { command_type: "read", command_line: '{"path":"a"}', step: 1 },
      { command_type: "grep", command_line: '{"pattern":"a"}', step: 1 },
      { command_type: "shell", command_line: "true", step: 1 },
    ]);
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];

    const results = await runCommandSchedule(commands, {
      signal: new AbortController().signal,
      ask: async () => undefined,
      execute: async command => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        order.push(`start:${command.command_type}`);
        await new Promise(resolve => setTimeout(resolve, 10));
        order.push(`end:${command.command_type}`);
        active -= 1;
        return { output: "ok" };
      },
      executionClass,
      maxOutputChars: 20_000,
    });

    expect(maximumActive).toBe(2);
    expect(order.indexOf("start:shell")).toBeGreaterThan(order.indexOf("end:grep"));
    expect(results.every(result => result.status === "completed")).toBe(true);
  });

  test("cancels later steps after failure", async () => {
    const commands = parseCommands([
      { command_type: "shell", command_line: "false", step: 1 },
      { command_type: "read", command_line: '{"path":"never"}', step: 2 },
    ]);
    const results = await runCommandSchedule(commands, {
      signal: new AbortController().signal,
      ask: async () => undefined,
      execute: async command => {
        if (command.step === 1) throw new Error("boom");
        return { output: "unexpected" };
      },
      executionClass,
      maxOutputChars: 20_000,
    });

    expect(results.map(result => result.status)).toEqual(["failed", "cancelled"]);
  });

  test("blocks traversal and symlink escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "command-run-root-"));
    const outside = await mkdtemp(join(tmpdir(), "command-run-outside-"));
    await mkdir(join(root, "inside"));
    await symlink(outside, join(root, "outside-link"));

    await expect(resolveWorkspacePath(root, "../escape")).rejects.toThrow(/escapes workspace/);
    await expect(resolveWorkspacePath(root, "outside-link/file.txt")).rejects.toThrow(/escapes workspace/);
  });

  test("reads text and returns image attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "command-run-media-"));
    await writeFile(join(root, "note.txt"), "one\ntwo\nthree");
    await writeFile(join(root, "pixel.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const [read, media] = parseCommands([
      { command_type: "read", command_line: '{"path":"note.txt","offset":1,"limit":1}', step: 1 },
      { command_type: "read_media", command_line: '{"path":"pixel.png"}', step: 1 },
    ]);

    const readResult = await executeAdapter(read!, root, new AbortController().signal);
    const mediaResult = await executeAdapter(media!, root, new AbortController().signal);

    expect(readResult.output).toBe("two");
    expect(mediaResult.attachments?.[0]?.mime).toBe("image/png");
  });

  test("rejects loopback web targets before fetching", async () => {
    const [command] = parseCommands([
      { command_type: "web_discover", command_line: '{"url":"http://127.0.0.1/private","mode":"extract"}', step: 1 },
    ]);

    await expect(executeAdapter(command!, process.cwd(), new AbortController().signal)).rejects.toThrow(/private|loopback|blocked|IP literal/i);
  });
});
