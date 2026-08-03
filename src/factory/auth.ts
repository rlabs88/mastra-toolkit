import { MastraAuthWorkos } from "@mastra/auth-workos";
import { SimpleAuth } from "@mastra/core/server";
import type { ToolkitConfig } from "../config.js";

interface LocalFactoryUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly organizationId: string;
}

const LOCAL_USER: LocalFactoryUser = {
  id: "local-user",
  email: "local@mastra-toolkit.invalid",
  name: "Local Mastra Toolkit",
  organizationId: "local-org",
};

class LocalFactoryAuth extends SimpleAuth<LocalFactoryUser> {
  constructor() {
    super({ tokens: { local: LOCAL_USER } });
  }

  override async authenticateToken(): Promise<LocalFactoryUser> {
    return LOCAL_USER;
  }
}

export function createFactoryAuth(
  workos: ToolkitConfig["workos"],
  nodeEnvironment = process.env.NODE_ENV,
): MastraAuthWorkos | LocalFactoryAuth {
  if (workos) {
    return new MastraAuthWorkos({
      apiKey: workos.apiKey,
      clientId: workos.clientId,
      redirectUri: "http://localhost:4111/auth/callback",
      session: { cookiePassword: workos.cookiePassword, secure: false, sameSite: "Lax" },
    });
  }
  if (nodeEnvironment === "production") {
    throw new Error("WorkOS credentials are required for Factory in production");
  }
  return new LocalFactoryAuth();
}
