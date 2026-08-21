import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createApplication } from "../../dist/app.js";
import { quotePosix } from "../../dist/ssh/executor.js";
import { runProcess } from "../../dist/credentials/process.js";

const passwordServerId = process.env.AI_OPS_E2E_SERVER_ID;
if (!passwordServerId) throw new Error("AI_OPS_E2E_SERVER_ID is required.");

const agentExecutable = process.env.AI_OPS_E2E_SSH_AGENT ?? "ssh-agent";
const sshAddExecutable = process.env.AI_OPS_E2E_SSH_ADD ?? "ssh-add";
const cygpathExecutable = process.env.AI_OPS_E2E_CYGPATH ?? "cygpath";
const runId = randomUUID().replaceAll("-", "");
const agentServerId = `e2e-agent-${runId}`;
const keyDir = path.resolve(`.ai-ops-test/agent-${runId}`);
const keyPath = path.join(keyDir, "id_ed25519");
const comment = `ai-ops-agent-e2e-${runId}`;
const importedServerId = `e2e-import-${runId}`;
const sshAlias = `ai-ops-import-${runId}`;
const app = await createApplication();
const originalConfig = await app.repository.load();
const passwordServer = await app.repository.getServer(passwordServerId);
const results = [];
let agentEnvironment;

function runWithEnvironment(command, args, environment, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({
      exitCode: exitCode ?? -1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(stdin);
  });
}

try {
  const started = await runProcess(agentExecutable, ["-s"]);
  assert.equal(started.exitCode, 0, started.stderr);
  const socket = /SSH_AUTH_SOCK=([^;\r\n]+)/.exec(started.stdout)?.[1];
  const pid = /SSH_AGENT_PID=([0-9]+)/.exec(started.stdout)?.[1];
  assert(socket && pid, `Unable to parse ssh-agent output: ${started.stdout}`);
  agentEnvironment = { SSH_AUTH_SOCK: socket, SSH_AGENT_PID: pid };
  const convertedSocket = await runWithEnvironment(cygpathExecutable, ["-w", socket], agentEnvironment);
  assert.equal(convertedSocket.exitCode, 0, convertedSocket.stderr);
  process.env.SSH_AUTH_SOCK = convertedSocket.stdout.trim();
  process.env.SSH_AGENT_PID = pid;

  await mkdir(keyDir, { recursive: true });
  const generated = await runProcess("ssh-keygen", [
    "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath,
  ]);
  assert.equal(generated.exitCode, 0, generated.stderr);
  const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
  const fingerprintResult = await runProcess("ssh-keygen", ["-lf", `${keyPath}.pub`, "-E", "sha256"]);
  assert.equal(fingerprintResult.exitCode, 0, fingerprintResult.stderr);
  const fingerprint = /SHA256:[A-Za-z0-9+/]+/.exec(fingerprintResult.stdout)?.[0];
  assert(fingerprint);

  const added = await runWithEnvironment(sshAddExecutable, [keyPath], agentEnvironment);
  assert.equal(added.exitCode, 0, added.stderr);
  const listed = await runWithEnvironment(sshAddExecutable, ["-l", "-E", "sha256"], agentEnvironment);
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert(listed.stdout.includes(fingerprint), `SSH Agent did not list fingerprint ${fingerprint}.`);

  const install = await app.operations.runCommand({
    serverId: passwordServerId,
    command: `mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\\n' ${quotePosix(publicKey)} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
  });
  assert.equal(install.exitCode, 0, install.stderr);

  const sshConfigPath = path.join(keyDir, "ssh_config");
  await writeFile(sshConfigPath, [
    `Host ${sshAlias}`,
    `  HostName ${passwordServer.host}`,
    `  Port ${passwordServer.port}`,
    `  User ${passwordServer.username}`,
    "",
  ].join("\n"), "utf8");
  const cliEnvironment = {
    ...agentEnvironment,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    AI_OPS_HOME: process.env.AI_OPS_HOME,
  };
  const imported = await runWithEnvironment(process.execPath, [
    path.resolve("dist/index.js"), "import-ssh", sshAlias,
    "--config", sshConfigPath, "--id", importedServerId,
  ], cliEnvironment, "y\n");
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  assert(await app.repository.getServer(importedServerId));
  results.push({ name: "CLI import-ssh custom config and live Agent connection", status: "passed" });

  const removedImport = await runWithEnvironment(process.execPath, [
    path.resolve("dist/index.js"), "remove", importedServerId, "--yes",
  ], cliEnvironment);
  assert.equal(removedImport.exitCode, 0, removedImport.stderr || removedImport.stdout);
  await assert.rejects(() => app.repository.getServer(importedServerId), (error) => error?.code === "SERVER_NOT_FOUND");
  results.push({ name: "CLI remove imported server", status: "passed" });

  await app.repository.upsertServer({
    ...passwordServer,
    id: agentServerId,
    name: agentServerId,
    auth: { type: "agent", publicKeyFingerprint: fingerprint },
  });
  const connected = await app.operations.testConnection(agentServerId);
  assert.equal(connected.connected, true);
  const command = await app.operations.runCommand({ serverId: agentServerId, command: "printf 'agent-ok\\n'" });
  assert.equal(command.stdout, "agent-ok\n");
  results.push({ name: "Git OpenSSH Agent authentication", status: "passed", fingerprint });

  const agentServer = await app.repository.getServer(agentServerId);
  await app.repository.upsertServer({
    ...agentServer,
    auth: { type: "agent", publicKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  });
  await app.pool.invalidate(agentServerId);
  await assert.rejects(
    () => app.operations.testConnection(agentServerId),
    (error) => {
      assert.equal(error?.code, "AGENT_IDENTITY_NOT_FOUND");
      return true;
    },
  );
  results.push({ name: "Agent fingerprint filtering", status: "passed" });
} finally {
  await app.repository.upsertServer(passwordServer).catch(() => undefined);
  await app.pool.invalidate(passwordServerId).catch(() => undefined);
  try {
    const cleanup = await app.operations.runCommand({
      serverId: passwordServerId,
      command: `if [ -f ~/.ssh/authorized_keys ]; then grep -v -- ${quotePosix(comment)} ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.ai-ops-tmp && mv ~/.ssh/authorized_keys.ai-ops-tmp ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys; fi`,
    });
    assert.equal(cleanup.exitCode, 0, cleanup.stderr);
  } catch {
    // The unique public-key comment makes a later manual cleanup unambiguous.
  }
  await app.repository.save(originalConfig);
  await app.operations.close();
  if (agentEnvironment) {
    await runWithEnvironment(sshAddExecutable, ["-D"], agentEnvironment).catch(() => undefined);
    await runWithEnvironment(agentExecutable, ["-k"], agentEnvironment).catch(() => undefined);
  }
  delete process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AGENT_PID;
  await rm(keyDir, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ results, cleanupComment: comment }, null, 2)}\n`);
