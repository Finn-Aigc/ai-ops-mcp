import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../../dist/app.js";

const serverId = process.env.AI_OPS_E2E_SERVER_ID;
if (!serverId) throw new Error("AI_OPS_E2E_SERVER_ID is required.");

const runId = randomUUID().replaceAll("-", "");
const remoteRoot = `/tmp/ai-ops-e2e-${runId}`;
const localRoot = path.resolve(`.ai-ops-test/files-${runId}`);
const uploadPath = path.join(localRoot, "upload.txt");
const downloadPath = path.join(localRoot, "download.txt");
const largeUploadPath = path.join(localRoot, "large-upload.bin");
const largeDownloadPath = path.join(localRoot, "large-download.bin");
const outsideLocalPath = path.join(os.tmpdir(), `ai-ops-e2e-outside-${runId}.txt`);
const remoteFile = `${remoteRoot}/payload.txt`;
const payload = `ai-ops-e2e-${runId}\n`;
const results = [];
const app = await createApplication();
const originalConfig = await app.repository.load();
const originalServer = await app.repository.getServer(serverId);

function pass(name, details = undefined) {
  results.push({ name, status: "passed", ...(details === undefined ? {} : { details }) });
}

async function expectCode(name, code, operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
  pass(name, code);
}

try {
  await mkdir(localRoot, { recursive: true });
  await writeFile(uploadPath, payload, "utf8");
  await writeFile(largeUploadPath, Buffer.alloc(128, 120));
  await writeFile(outsideLocalPath, payload, "utf8");

  await app.repository.save({
    ...originalConfig,
    defaults: { ...originalConfig.defaults, maxGlobalChannels: 1 },
  });

  await app.repository.upsertServer({
    ...originalServer,
    allowedLocalPaths: [localRoot],
    allowedRemotePaths: [remoteRoot],
    limits: {
      ...originalServer.limits,
      commandTimeoutMs: 30_000,
      sftpTimeoutMs: 30_000,
      maxOutputBytes: 1_024,
      maxFileBytes: 64,
      maxChannels: 4,
    },
  });
  await app.pool.invalidate(serverId);

  const connection = await app.operations.testConnection(serverId);
  assert.equal(connection.connected, true);
  pass("password authentication and trusted Host key", connection);

  const configuredServer = await app.repository.getServer(serverId);
  const clientA = await app.pool.acquire(configuredServer);
  const clientB = await app.pool.acquire(configuredServer);
  assert.strictEqual(clientA, clientB);
  pass("SSH connection reuse");

  const globalSlow = app.operations.runCommand({ serverId, command: "sleep 1" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await expectCode("global concurrency limit", "CONCURRENCY_LIMIT", () =>
    app.operations.runCommand({ serverId, command: "printf blocked" }),
  );
  await globalSlow;

  const globallyRelaxed = await app.repository.load();
  await app.repository.save({
    ...globallyRelaxed,
    defaults: { ...globallyRelaxed.defaults, maxGlobalChannels: 16 },
    servers: globallyRelaxed.servers.map((item) => item.id === serverId
      ? { ...item, limits: { ...item.limits, maxChannels: 1 } }
      : item),
  });
  const serverSlow = app.operations.runCommand({ serverId, command: "sleep 1" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await expectCode("per-server concurrency limit", "CONCURRENCY_LIMIT", () =>
    app.operations.runCommand({ serverId, command: "printf blocked" }),
  );
  await serverSlow;

  const create = await app.operations.runCommand({
    serverId,
    command: `mkdir -p ${remoteRoot} && chmod 700 ${remoteRoot}`,
  });
  assert.equal(create.exitCode, 0);
  pass("remote temporary directory setup");

  const success = await app.operations.runCommand({ serverId, command: "printf 'command-ok\\n'" });
  assert.equal(success.stdout, "command-ok\n");
  assert.equal(success.exitCode, 0);
  pass("command stdout and zero exit", success);

  const failure = await app.operations.runCommand({
    serverId,
    command: "sh -c 'printf error-output >&2; exit 7'",
  });
  assert.equal(failure.stderr, "error-output");
  assert.equal(failure.exitCode, 7);
  pass("command stderr and non-zero exit", failure);

  const cwd = await app.operations.runCommand({ serverId, command: "pwd", cwd: remoteRoot });
  assert.equal(cwd.stdout.trim(), remoteRoot);
  pass("remote working directory quoting", cwd.stdout.trim());

  await expectCode("command timeout", "COMMAND_TIMEOUT", () =>
    app.operations.runCommand({ serverId, command: "sleep 2", timeoutMs: 200 }),
  );

  const truncated = await app.operations.runCommand({
    serverId,
    command: "head -c 4096 /dev/zero | tr '\\0' x",
  });
  assert.equal(truncated.truncated, true);
  assert.equal(Buffer.byteLength(truncated.stdout) + Buffer.byteLength(truncated.stderr), 1_024);
  pass("combined output truncation", 1_024);

  await app.operations.upload({ serverId, localPath: uploadPath, remotePath: remoteFile });
  pass("SFTP upload");
  await expectCode("upload file size limit", "FILE_SIZE_LIMIT_EXCEEDED", () =>
    app.operations.upload({ serverId, localPath: largeUploadPath, remotePath: `${remoteRoot}/too-large-upload.bin` }),
  );

  const entries = await app.operations.listDir({ serverId, remotePath: remoteRoot });
  assert(entries.some((entry) => entry.name === "payload.txt" && entry.size === Buffer.byteLength(payload)));
  pass("SFTP directory listing", entries);

  await app.operations.download({ serverId, remotePath: remoteFile, localPath: downloadPath });
  assert.equal(await readFile(downloadPath, "utf8"), payload);
  pass("SFTP download and content integrity");

  const createLargeRemote = await app.operations.runCommand({
    serverId,
    command: `head -c 128 /dev/zero > ${remoteRoot}/too-large-download.bin`,
  });
  assert.equal(createLargeRemote.exitCode, 0);
  await expectCode("download file size limit", "FILE_SIZE_LIMIT_EXCEEDED", () =>
    app.operations.download({
      serverId,
      remotePath: `${remoteRoot}/too-large-download.bin`,
      localPath: largeDownloadPath,
    }),
  );

  await expectCode("download overwrite protection", "LOCAL_FILE_EXISTS", () =>
    app.operations.download({ serverId, remotePath: remoteFile, localPath: downloadPath }),
  );
  await app.operations.download({
    serverId,
    remotePath: remoteFile,
    localPath: downloadPath,
    overwrite: true,
  });
  pass("explicit download overwrite");

  await expectCode("remote path boundary", "REMOTE_PATH_NOT_ALLOWED", () =>
    app.operations.listDir({ serverId, remotePath: "/tmp" }),
  );
  await expectCode("local path boundary", "LOCAL_PATH_NOT_ALLOWED", () =>
    app.operations.upload({ serverId, localPath: outsideLocalPath, remotePath: remoteFile }),
  );

  const logs = await app.audit.read(200);
  const actions = new Set(logs.filter((entry) => entry.server_id === serverId).map((entry) => entry.action));
  for (const action of ["test_connection", "execute_command", "upload_file", "download_file", "list_dir"]) {
    assert(actions.has(action), `Missing audit action: ${action}`);
  }
  pass("structured audit coverage", [...actions].sort());
} finally {
  try {
    const cleanupServer = await app.repository.getServer(serverId);
    const client = await app.pool.acquire(cleanupServer);
    await new Promise((resolve) => {
      client.exec(`rm -rf -- ${remoteRoot}`, (_error, stream) => {
        if (!stream) return resolve();
        stream.on("close", resolve);
        stream.resume();
      });
    });
  } catch {
    // The unique /tmp path is reported below if cleanup cannot connect.
  }
  await app.repository.save(originalConfig);
  await app.operations.close();
  await rm(localRoot, { recursive: true, force: true });
  await rm(outsideLocalPath, { force: true });
}

process.stdout.write(`${JSON.stringify({ serverId, remoteRoot, results }, null, 2)}\n`);
