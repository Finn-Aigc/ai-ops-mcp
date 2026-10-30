import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "ssh2";
import { probeHostKey } from "../../src/ssh/host-key.js";

test("host key probe ignores socket errors emitted after settle", async () => {
  const originalConnect = Client.prototype.connect;
  const originalEnd = Client.prototype.end;
  Client.prototype.connect = function (this: Client) {
    // Windows OpenSSH can reset the probe socket twice after the host key
    // was already delivered. Only the first error may settle the promise;
    // later ones must not crash the process with an unhandled 'error' event.
    setImmediate(() => this.emit("error", new Error("probe teardown reset 1")));
    setImmediate(() => this.emit("error", new Error("probe teardown reset 2")));
    return this;
  };
  Client.prototype.end = () => {};
  try {
    await assert.rejects(() => probeHostKey("127.0.0.1", 22, 5_000), { message: "probe teardown reset 1" });
    // Let both queued error emissions run before the test ends.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.end = originalEnd;
  }
});
