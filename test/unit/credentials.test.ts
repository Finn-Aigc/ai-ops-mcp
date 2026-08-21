import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgentSocket } from "../../src/credentials/providers.js";
import { KeyringSecretStore } from "../../src/credentials/keyring-secret-store.js";
import { createSystemSecretStore } from "../../src/credentials/secret-store.js";

test("agent socket uses SSH_AUTH_SOCK when present", () => {
  assert.equal(resolveAgentSocket({ SSH_AUTH_SOCK: "socket-test" }), "socket-test");
});

test("system secret store uses the native N-API keyring", () => {
  assert.equal(createSystemSecretStore("win32").constructor.name, "KeyringSecretStore");
  assert.equal(createSystemSecretStore("darwin").constructor.name, "KeyringSecretStore");
  assert.equal(createSystemSecretStore("linux").constructor.name, "KeyringSecretStore");
});

test("keyring store preserves native missing-entry semantics", async () => {
  const values = new Map<string, string>();
  const store = new KeyringSecretStore((_service, reference) => ({
    async setPassword(value) {
      values.set(reference, value);
    },
    async getPassword() {
      return values.get(reference);
    },
    async deleteCredential() {
      return values.delete(reference);
    },
  }));

  assert.equal(await store.get("missing"), null);
  assert.equal(await store.delete("missing"), false);
  await store.set("saved", "value");
  assert.equal(await store.get("saved"), "value");
  assert.equal(await store.delete("saved"), true);
  assert.equal(await store.get("saved"), null);
});

test("keyring store maps native failures to an application error", async () => {
  const store = new KeyringSecretStore(() => ({
    async setPassword() {
      throw new Error("native failure");
    },
    async getPassword() {
      throw new Error("native failure");
    },
    async deleteCredential() {
      throw new Error("native failure");
    },
  }));

  await assert.rejects(() => store.get("broken"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "CREDENTIAL_STORE_UNAVAILABLE");
    return true;
  });
});
