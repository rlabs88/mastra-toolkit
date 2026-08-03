const factory = [
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_WEBHOOK_SECRET",
];

const proxyPresent = Boolean(process.env.PROXY_API_KEY?.trim() || process.env.CLI_PROXY_API_KEY?.trim());
const names = process.env.MASTRA_TOOLKIT_MODE === "factory" ? factory : [];
const missing = names.filter(name => !process.env[name]?.trim());
if (!proxyPresent) missing.unshift("PROXY_API_KEY or CLI_PROXY_API_KEY");
if (missing.length > 0) {
  console.error(`Missing required secret names: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`Infisical injection valid for ${process.env.MASTRA_TOOLKIT_MODE === "factory" ? "factory" : "standalone"} mode (${names.length + 1} credential groups present).`);
