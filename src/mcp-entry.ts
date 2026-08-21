#!/usr/bin/env node
import { createApplication } from "./app.js";
import { normalizeError } from "./errors/app-error.js";
import { runMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const app = await createApplication();
  await runMcpServer(app.operations);
}

main().catch((error: unknown) => {
  const normalized = normalizeError(error);
  process.stderr.write(`${normalized.code}: ${normalized.message}\n`);
  process.exitCode = 1;
});
