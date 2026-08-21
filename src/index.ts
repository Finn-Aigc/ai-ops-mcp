#!/usr/bin/env node
import path from "node:path";
import { createApplication } from "./app.js";
import { createCli } from "./cli/program.js";
import { closePrompts } from "./cli/prompts.js";
import { normalizeError } from "./errors/app-error.js";
import { runMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const app = await createApplication();
  const invokedAs = path.basename(process.argv[1] ?? "ai-ops").toLowerCase();
  if (invokedAs.includes("ai-ops-mcp") || process.argv[2] === "mcp") {
    if (process.argv[2] === "mcp") process.argv.splice(2, 1);
    await runMcpServer(app.operations);
    return;
  }
  try {
    await createCli(app).parseAsync(process.argv);
  } finally {
    closePrompts();
    await app.operations.close();
  }
}

main().catch((error: unknown) => {
  const normalized = normalizeError(error);
  process.stderr.write(`${normalized.code}: ${normalized.message}\n`);
  if (normalized.action) process.stderr.write(`${normalized.action}\n`);
  process.exitCode = 1;
});
