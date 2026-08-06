import { MastraAuthWorkos } from "@mastra/auth-workos";
import { SimpleAuth } from "@mastra/core/server";
import type { FactoryConfig } from "./config.js";

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
  workos: FactoryConfig["workos"],
  nodeEnvironment = process.env.NODE_ENV,
  server: FactoryConfig["server"] = {
    publicUrl: "http://localhost:4111",
    allowedOrigins: ["http://localhost:4111"],
  },
  mastraDevelopment = process.env.MASTRA_DEV === "true" || process.env.MASTRA_FACTORY_DEV === "true",
): MastraAuthWorkos | LocalFactoryAuth {
  if (workos) {
    const secure = server.publicUrl.startsWith("https://");
    const crossSite = server.allowedOrigins.some(origin => origin !== server.publicUrl);
    return new MastraAuthWorkos({
      apiKey: workos.apiKey,
      clientId: workos.clientId,
      redirectUri: `${server.publicUrl}/auth/callback`,
      session: {
        cookiePassword: workos.cookiePassword,
        secure,
        sameSite: crossSite ? "None" : "Lax",
      },
    });
  }
  if (nodeEnvironment === "production" && !mastraDevelopment) {
    throw new Error("WorkOS credentials are required for Factory in production");
  }
  return new LocalFactoryAuth();
}
