import test from "node:test";
import assert from "node:assert/strict";
import { appConfigSchema, assertNoSecretFields } from "../../src/config/schema.js";
import { ConfigRepository } from "../../src/config/repository.js";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("config rejects secret fields", () => {
  assert.throws(() => assertNoSecretFields({ servers: [{ password: "bad" }] }), /Secret field/);
});

test("config applies safe defaults", () => {
  const config = appConfigSchema.parse({ version: 1, servers: [] });
  assert.equal(config.defaults.commandTimeoutMs, 30_000);
  assert.equal(config.defaults.maxOutputBytes, 10 * 1024 * 1024);
});

test("config repository writes and reloads an atomic private config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-ops-config-"));
  const file = path.join(directory, "config.json");
  const repository = new ConfigRepository(file);
  const config = appConfigSchema.parse({ version: 1, servers: [] });
  await repository.save(config);
  assert.deepEqual(await repository.load(), config);
  assert.doesNotMatch(await readFile(file, "utf8"), /password|passphrase/);
});
