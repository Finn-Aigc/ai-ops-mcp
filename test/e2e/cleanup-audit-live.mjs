import assert from "node:assert/strict";
import { createApplication } from "../../dist/app.js";

const serverId = process.env.AI_OPS_E2E_SERVER_ID;
if (!serverId) throw new Error("AI_OPS_E2E_SERVER_ID is required.");
const app = await createApplication();
try {
  const server = await app.repository.getServer(serverId);
  const first = await app.pool.acquire(server);
  first.end();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const reconnect = await app.operations.runCommand({ serverId, command: "printf 'reconnect-ok\\n'" });
  assert.equal(reconnect.stdout, "reconnect-ok\n");

  const temporaryDirectories = await app.operations.runCommand({
    serverId,
    command: "find /tmp -maxdepth 1 -type d -name 'ai-ops-e2e-*' -o -type d -name 'ai-ops-mcp-e2e-*'",
  });
  assert.equal(temporaryDirectories.stdout.trim(), "");

  const testKeys = await app.operations.runCommand({
    serverId,
    command: "if [ -f ~/.ssh/authorized_keys ]; then grep -E 'ai-ops-(agent-)?e2e-' ~/.ssh/authorized_keys || true; fi",
  });
  assert.equal(testKeys.stdout.trim(), "");

  process.stdout.write(`${JSON.stringify({
    reconnect: "passed",
    remoteTemporaryDirectories: 0,
    remoteTestAuthorizedKeys: 0,
  }, null, 2)}\n`);
} finally {
  await app.operations.close();
}
