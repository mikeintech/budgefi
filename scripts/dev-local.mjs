import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const localWebOrigins = ["http://localhost:4411", "http://127.0.0.1:4411", ...Object.values(networkInterfaces()).flat().filter((address) => address?.family === "IPv4" && !address.internal).map((address) => `http://${address.address}:4411`)];

const environment = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55432/budgefi",
  ALLOW_DEV_AUTH: process.env.ALLOW_DEV_AUTH ?? "true",
  ALLOW_USER_PROVISIONING: process.env.ALLOW_USER_PROVISIONING ?? "true",
  NODE_ENV: "development",
  API_PORT: process.env.API_PORT ?? "4422",
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? localWebOrigins.join(","),
};

const children = [run("npm", ["run", "dev:api"]), run("npm", ["run", "dev", "--", "--port", process.env.WEB_PORT ?? "4411"])];
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
for (const child of children) child.on("exit", (code) => { if (!stopping) { process.exitCode = code ?? 1; stop("SIGTERM"); } });

function run(command, args) {
  return spawn(command, args, { env: environment, stdio: "inherit" });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill(signal);
}
