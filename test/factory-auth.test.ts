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

  test("provides local auth when the production bundle is explicitly running under Factory dev", async () => {
    const auth = createFactoryAuth(undefined, "production", undefined, true);
    const user = await auth.authenticateToken("", new Request("http://localhost:4111/web/factory/projects"));

    expect(user).toMatchObject({ id: "local-user", organizationId: "local-org" });
  });

  test("uses the deployed Factory origin and emits secure cross-site WorkOS cookies in production", async () => {
    const previousNodeEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const auth = createFactoryAuth({
      apiKey: "workos-key",
      clientId: "workos-client",
      cookiePassword: "x".repeat(32),
    }, "production", {
      publicUrl: "https://factory.example.com",
      allowedOrigins: ["https://app.example.com"],
    }) as unknown as {
      redirectUri: string;
      workos: {
        userManagement: {
          authenticateWithCode(input: unknown): Promise<unknown>;
        };
      };
      handleCallback(code: string, state: string): Promise<{ cookies?: string[] }>;
    };
    auth.workos.userManagement.authenticateWithCode = async () => ({
      user: {
        id: "workos-user",
        email: "user@example.com",
        firstName: "Factory",
        lastName: "User",
        emailVerified: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      organizationId: "workos-org",
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
    });

    try {
      expect(auth.redirectUri).toBe("https://factory.example.com/auth/callback");
      const result = await auth.handleCallback("test-code", "test-state");
      expect(result.cookies?.[0]).toMatch(/; SameSite=None; Secure$/i);
    } finally {
      if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnvironment;
    }
  });
});
