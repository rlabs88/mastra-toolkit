const proxyPresent = Boolean(process.env.PROXY_API_KEY?.trim() || process.env.CLI_PROXY_API_KEY?.trim());
const factoryProfile = process.env.FACTORY_PROJECT_RUNTIME_PROFILE ?? "ephemeral-development";
let names = [];
if (process.env.MASTRA_TOOLKIT_MODE === "factory") {
  try {
    const { register } = await import("tsx/esm/api");
    register();
    const { requiredFactorySecretNames } = await import("@rlabs/factory-integration");
    names = [...requiredFactorySecretNames(process.env)];
  } catch (error) {
    console.error(`Invalid Factory secret profile: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
const missing = names.filter(name => !process.env[name]?.trim());
if (!proxyPresent) missing.unshift("PROXY_API_KEY or CLI_PROXY_API_KEY");
if (missing.length > 0) {
  console.error(`Missing required secret names: ${missing.join(", ")}`);
  process.exit(1);
}
const mode = process.env.MASTRA_TOOLKIT_MODE === "factory" ? `factory ${factoryProfile}` : "standalone";
console.log(`Infisical injection valid for ${mode} mode (${names.length + 1} credential groups present).`);
