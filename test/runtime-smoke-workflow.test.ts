import { describe, expect, test } from "vitest";
import runtimeSmokeWorkflow from "../.mastracode/workflow/runtime-smoke.js";

describe("local runtime smoke workflow", () => {
  test("returns evidence that it executed in the embedded project runtime", async () => {
    const run = await runtimeSmokeWorkflow.createRun();
    const result = await run.start({ inputData: { message: "hello" } });

    expect(result).toMatchObject({
      status: "success",
      result: { message: "hello", runtime: "local" },
    });
  });
});
