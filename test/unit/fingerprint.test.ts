import test from "node:test";
import assert from "node:assert/strict";
import { readSshKeyAlgorithm, sha256Fingerprint } from "../../src/utils/fingerprint.js";
import { quotePosix } from "../../src/ssh/executor.js";

test("fingerprint is SSH SHA256 format", () => {
  const key = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from("payload")]);
  assert.equal(readSshKeyAlgorithm(key), "ssh-ed25519");
  assert.match(sha256Fingerprint(key), /^SHA256:[A-Za-z0-9+/]+$/);
});

test("POSIX quoting handles single quotes", () => {
  assert.equal(quotePosix("/tmp/user's dir"), `'/tmp/user'"'"'s dir'`);
});
