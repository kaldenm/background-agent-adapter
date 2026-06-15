/**
 * Generate the ignored OpenNext Cloudflare production Wrangler config.
 *
 * Terraform also generates this file during managed deploys. This script keeps
 * the root npm deploy scripts usable for direct Wrangler deploys from a fresh
 * clone without committing deployment-local generated config.
 */

import fs from "node:fs";
import path from "node:path";

function env(name: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name]! : fallback;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

const deploymentName = env("DEPLOYMENT_NAME", "aldenmyers");
const workerSubdomain = env("CLOUDFLARE_WORKER_SUBDOMAIN", "kaldenmyers");
const githubClientId = env("GITHUB_CLIENT_ID", "Iv23li9vud1CCu9KNzLN");
const sandboxProvider = env("SANDBOX_PROVIDER", "daytona");
const allowedUsers = env("ALLOWED_USERS", "kaldenm");
const allowedEmailDomains = env("ALLOWED_EMAIL_DOMAINS", "");
const unsafeAllowAllUsers = env("UNSAFE_ALLOW_ALL_USERS", "false");

const webWorkerName = `open-inspect-web-${deploymentName}`;
const controlPlaneWorkerName = `open-inspect-control-plane-${deploymentName}`;
const controlPlaneHost = `${controlPlaneWorkerName}.${workerSubdomain}.workers.dev`;
const webAppUrl = env("NEXTAUTH_URL", `https://${webWorkerName}.${workerSubdomain}.workers.dev`);
const serverUrl = env("SERVER_URL", `https://${controlPlaneHost}`);
const wsUrl = env("NEXT_PUBLIC_WS_URL", `wss://${controlPlaneHost}`);

const outputPath = path.resolve("packages/web/wrangler.production.toml");
const content = `name = ${tomlString(webWorkerName)}
main = ".open-next/worker.js"
compatibility_date = "2025-08-15"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]

[vars]
GITHUB_CLIENT_ID = ${tomlString(githubClientId)}
NEXTAUTH_URL = ${tomlString(webAppUrl)}
SERVER_URL = ${tomlString(serverUrl)}
NEXT_PUBLIC_WS_URL = ${tomlString(wsUrl)}
NEXT_PUBLIC_SANDBOX_PROVIDER = ${tomlString(sandboxProvider)}
ALLOWED_USERS = ${tomlString(allowedUsers)}
ALLOWED_EMAIL_DOMAINS = ${tomlString(allowedEmailDomains)}
UNSAFE_ALLOW_ALL_USERS = ${tomlString(unsafeAllowAllUsers)}

[assets]
directory = ".open-next/assets"
binding = "ASSETS"

[[services]]
binding = "CONTROL_PLANE_WORKER"
service = ${tomlString(controlPlaneWorkerName)}
`;

fs.writeFileSync(outputPath, content);
console.log(`Generated ${outputPath}`);
