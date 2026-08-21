import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createApplication } from "../../dist/app.js";
import { quotePosix } from "../../dist/ssh/executor.js";
import { runProcess } from "../../dist/credentials/process.js";

const passwordServerId = process.env.AI_OPS_E2E_SERVER_ID;
if (!passwordServerId) throw new Error("AI_OPS_E2E_SERVER_ID is required.");

const runId = randomUUID().replaceAll("-", "");
const privateServerId = `e2e-private-${runId}`;
const credentialRef = `server/${privateServerId}/passphrase`;
const keyDir = path.resolve(`.ai-ops-test/keys-${runId}`);
const keyPath = path.join(keyDir, "id_ed25519");
const comment = `ai-ops-e2e-${runId}`;
const passphrase = `e2e-${randomUUID()}`;
const app = await createApplication();
const originalConfig = await app.repository.load();
const passwordServer = await app.repository.getServer(passwordServerId);
const results = [];
let originalPassword;

try {
  assert.equal(passwordServer.auth.type, "systemCredential");
  originalPassword = await app.secretStore.get(passwordServer.auth.credentialRef);
  assert(originalPassword);
  await app.secretStore.set(passwordServer.auth.credentialRef, "intentionally-wrong-e2e-password");
  await app.pool.invalidate(passwordServerId);
  await assert.rejects(
    () => app.operations.testConnection(passwordServerId),
    (error) => {
      assert.equal(error?.code, "SSH_AUTHENTICATION_FAILED");
      return true;
    },
  );
  results.push({ name: "wrong SSH password rejection", status: "passed" });
  await app.secretStore.set(passwordServer.auth.credentialRef, originalPassword);
  await app.pool.invalidate(passwordServerId);

  const missingCredentialServerId = `e2e-missing-${runId}`;
  await app.repository.upsertServer({
    ...passwordServer,
    id: missingCredentialServerId,
    name: missingCredentialServerId,
    auth: { type: "systemCredential", credentialRef: `missing/${runId}` },
  });
  await assert.rejects(
    () => app.operations.testConnection(missingCredentialServerId),
    (error) => {
      assert.equal(error?.code, "CREDENTIAL_NOT_FOUND");
      return true;
    },
  );
  results.push({ name: "missing system credential rejection", status: "passed" });

  await app.repository.upsertServer({
    ...passwordServer,
    hostKey: { ...passwordServer.hostKey, fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  });
  await app.pool.invalidate(passwordServerId);
  await assert.rejects(
    () => app.operations.testConnection(passwordServerId),
    (error) => {
      assert.equal(error?.code, "HOST_KEY_MISMATCH");
      return true;
    },
  );
  results.push({ name: "Host key mismatch rejection", status: "passed" });

  await app.repository.upsertServer(passwordServer);
  await app.pool.invalidate(passwordServerId);
  await mkdir(keyDir, { recursive: true });
  const generated = await runProcess("ssh-keygen", [
    "-q", "-t", "ed25519", "-N", passphrase, "-C", comment, "-f", keyPath,
  ]);
  assert.equal(generated.exitCode, 0, generated.stderr);
  const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();

  const install = await app.operations.runCommand({
    serverId: passwordServerId,
    command: `mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\\n' ${quotePosix(publicKey)} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
  });
  assert.equal(install.exitCode, 0, install.stderr);

  const addedPrivateKey = await runProcess(process.execPath, [
    path.resolve("dist/index.js"), "add",
    "--id", privateServerId,
    "--name", privateServerId,
    "--host", passwordServer.host,
    "--port", String(passwordServer.port),
    "--user", passwordServer.username,
    "--auth", "private-key",
    "--key", keyPath,
  ], { stdin: `y\ny\n${passphrase}\n`, timeoutMs: 60_000 });
  assert.equal(addedPrivateKey.exitCode, 0, addedPrivateKey.stderr || addedPrivateKey.stdout);
  const afterCliAdd = await app.repository.load();
  assert(
    afterCliAdd.servers.some((item) => item.id === privateServerId),
    `CLI add did not persist '${privateServerId}'. stdout=${JSON.stringify(addedPrivateKey.stdout)} stderr=${JSON.stringify(addedPrivateKey.stderr)}`,
  );

  const connected = await app.operations.testConnection(privateServerId);
  assert.equal(connected.connected, true);
  const command = await app.operations.runCommand({ serverId: privateServerId, command: "printf 'private-key-ok\\n'" });
  assert.equal(command.stdout, "private-key-ok\n");
  results.push({ name: "CLI add encrypted private key plus Credential Manager passphrase", status: "passed" });

  const editedPassphrase = await runProcess(process.execPath, [
    path.resolve("dist/index.js"), "edit", privateServerId, "--passphrase",
  ], { stdin: `${passphrase}\n`, timeoutMs: 30_000 });
  assert.equal(editedPassphrase.exitCode, 0, editedPassphrase.stderr || editedPassphrase.stdout);
  await app.pool.invalidate(privateServerId);
  assert.equal((await app.operations.testConnection(privateServerId)).connected, true);
  results.push({ name: "CLI edit encrypted private-key passphrase", status: "passed" });

  await app.secretStore.set(credentialRef, "intentionally-wrong-e2e-passphrase");
  await app.pool.invalidate(privateServerId);
  await assert.rejects(
    () => app.operations.testConnection(privateServerId),
    (error) => {
      assert.equal(error?.code, "SSH_AUTHENTICATION_FAILED");
      assert.match(error.message, /authentication failed/i);
      return true;
    },
  );
  results.push({ name: "wrong private-key passphrase rejection", status: "passed" });
} finally {
  if (originalPassword && passwordServer.auth.type === "systemCredential") {
    await app.secretStore.set(passwordServer.auth.credentialRef, originalPassword).catch(() => undefined);
  }
  await app.secretStore.set(credentialRef, passphrase).catch(() => undefined);
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
  await app.secretStore.delete(credentialRef).catch(() => undefined);
  await app.operations.close();
  await rm(keyDir, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ results, cleanupComment: comment }, null, 2)}\n`);
