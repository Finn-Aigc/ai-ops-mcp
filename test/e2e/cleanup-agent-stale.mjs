import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createApplication } from "../../dist/app.js";

const passwordServerId = process.env.AI_OPS_E2E_SERVER_ID;
if (!passwordServerId) throw new Error("AI_OPS_E2E_SERVER_ID is required.");
const app = await createApplication();
const config = await app.repository.load();
const staleServers = config.servers.filter((server) => server.id.startsWith("e2e-agent-"));

const cleanup = await app.operations.runCommand({
  serverId: passwordServerId,
  command: "if [ -f ~/.ssh/authorized_keys ]; then grep -v -- 'ai-ops-agent-e2e-' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.ai-ops-tmp && mv ~/.ssh/authorized_keys.ai-ops-tmp ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys; fi",
});
assert.equal(cleanup.exitCode, 0, cleanup.stderr);
for (const server of staleServers) await app.repository.removeServer(server.id);
await app.operations.close();

const testRoot = path.resolve(".ai-ops-test");
for (const entry of await readdir(testRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith("agent-")) {
    await rm(path.join(testRoot, entry.name), { recursive: true, force: true });
  }
}

const pid = Number.parseInt(process.env.AI_OPS_STALE_AGENT_PID ?? "", 10);
if (Number.isInteger(pid) && pid > 0) {
  try { process.kill(pid); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

process.stdout.write(`${JSON.stringify({ removedServerIds: staleServers.map((server) => server.id), stoppedPid: pid || null })}\n`);
