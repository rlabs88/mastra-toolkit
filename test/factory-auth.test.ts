import { describe, expect, test } from "vitest";
import { createFactoryAuth } from "@rlabs/factory-integration";

describe("createFactoryAuth", () => {
  test("provides a local tenant in development", async () => {
    const auth = createFactoryAuth(undefined, "development");
    const user = await auth.authenticateToken("", new Request("http://localhost:4111/web/factory/projects"));

    expect(user).toMatchObject({ id: "local-user", organizationId: "local-org" });
  });

  test("fails closed in production without WorkOS", () => {
    expect(() => createFactoryAuth(undefined, "production")).toThrow(/WorkOS/);
  });
});
