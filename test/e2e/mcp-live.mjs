import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ConfigRepository } from "../../dist/config/repository.js";
import { getAppPaths } from "../../dist/config/paths.js";

const serverId = process.env.AI_OPS_E2E_SERVER_ID;
if (!serverId) throw new Error("AI_OPS_E2E_SERVER_ID is required.");

const runId = randomUUID().replaceAll("-", "");
const remoteRoot = `/tmp/ai-ops-mcp-e2e-${runId}`;
const localRoot = path.resolve(`.ai-ops-test/mcp-files-${runId}`);
const sourcePath = path.join(localRoot, "source.txt");
const targetPath = path.join(localRoot, "target.txt");
const remotePath = `${remoteRoot}/mcp.txt`;
const payload = `mcp-live-${runId}\n`;
const repository = new ConfigRepository(getAppPaths().configFile);
const originalConfig = await repository.load();
const server = originalConfig.servers.find((item) => item.id === serverId);
if (!server) throw new Error(`Server '${serverId}' is not configured.`);

await mkdir(localRoot, { recursive: true });
await writeFile(sourcePath, payload, "utf8");
await repository.upsertServer({
  ...server,
  allowedLocalPaths: [localRoot],
  allowedRemotePaths: [remoteRoot],
});

const client = new Client({ name: "ai-ops-live-e2e", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/mcp-entry.js")],
  env: { ...process.env },
  stderr: "pipe",
});

function decode(response) {
  const block = response.content?.find((item) => item.type === "text");
  assert(block && typeof block.text === "string", "MCP response has no text content.");
  const value = JSON.parse(block.text);
  if (response.isError) throw Object.assign(new Error(value.message), value);
  return value;
}

const results = [];
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["download_file", "execute_command", "list_dir", "list_servers", "test_connection", "upload_file"],
  );
  results.push({ name: "MCP initialize and six-tool discovery", status: "passed" });

  const listed = decode(await client.callTool({ name: "list_servers", arguments: {} }));
  const listedServer = listed.servers.find((item) => item.id === serverId);
  assert(listedServer);
  assert.equal(listedServer.connected, false);
  assert.equal("host" in listedServer, false);
  assert.equal("username" in listedServer, false);
  results.push({ name: "list_servers metadata isolation", status: "passed" });

  const connected = decode(await client.callTool({ name: "test_connection", arguments: { server_id: serverId } }));
  assert.equal(connected.connected, true);
  results.push({ name: "test_connection", status: "passed", latencyMs: connected.latencyMs });
  const listedAfterConnection = decode(await client.callTool({ name: "list_servers", arguments: {} }));
  assert.equal(listedAfterConnection.servers.find((item) => item.id === serverId)?.connected, true);
  results.push({ name: "list_servers live connected state", status: "passed" });

  const setup = decode(await client.callTool({
    name: "execute_command",
    arguments: { server_id: serverId, command: `mkdir -p ${remoteRoot} && chmod 700 ${remoteRoot}` },
  }));
  assert.equal(setup.exitCode, 0);
  results.push({ name: "execute_command", status: "passed" });

  const uploaded = decode(await client.callTool({
    name: "upload_file",
    arguments: { server_id: serverId, local_path: sourcePath, remote_path: remotePath },
  }));
  assert.equal(uploaded.success, true);
  results.push({ name: "upload_file", status: "passed" });

  const listing = decode(await client.callTool({
    name: "list_dir",
    arguments: { server_id: serverId, remote_path: remoteRoot },
  }));
  assert(listing.entries.some((entry) => entry.name === "mcp.txt"));
  results.push({ name: "list_dir", status: "passed" });

  const downloaded = decode(await client.callTool({
    name: "download_file",
    arguments: { server_id: serverId, remote_path: remotePath, local_path: targetPath },
  }));
  assert.equal(downloaded.success, true);
  assert.equal(await readFile(targetPath, "utf8"), payload);
  results.push({ name: "download_file", status: "passed" });

  const cleanup = decode(await client.callTool({
    name: "execute_command",
    arguments: { server_id: serverId, command: `rm -rf -- ${remoteRoot}` },
  }));
  assert.equal(cleanup.exitCode, 0);
} finally {
  await client.close().catch(() => undefined);
  await repository.save(originalConfig);
  await rm(localRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ serverId, results }, null, 2)}\n`);
