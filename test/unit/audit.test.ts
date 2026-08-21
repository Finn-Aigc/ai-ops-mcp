import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuditLogger } from "../../src/audit/logger.js";

test("audit hash mode does not store full command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-ops-audit-"));
  const file = path.join(root, "audit.jsonl");
  const logger = new AuditLogger(file, "hash");
  await logger.write({ requestId: "r1", serverId: "s1", action: "execute_command", outcome: "success", durationMs: 1, command: "echo secret-password" });
  const events = await logger.read();
  const event = events[0] as Record<string, unknown>;
  assert.notEqual(event.command, "echo secret-password");
  assert.match(String(event.command), /^sha256:/);
});

test("audit rotates daily, filters events, and removes expired files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-ops-audit-"));
  const file = path.join(root, "audit.jsonl");
  await writeFile(path.join(root, "audit-2020-01-01.jsonl"), "{}\n", "utf8");
  const logger = new AuditLogger(file, "full", 30);
  await logger.write({
    timestamp: "2026-08-19T10:00:00.000Z",
    requestId: "r1",
    serverId: "s1",
    action: "execute_command",
    outcome: "success",
    durationMs: 1,
  });
  await logger.write({
    timestamp: "2026-08-20T10:00:00.000Z",
    requestId: "r2",
    serverId: "s2",
    action: "upload_file",
    outcome: "success",
    durationMs: 1,
  });
  const filtered = await logger.read({ serverId: "s2", action: "upload_file", limit: 10 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.request_id, "r2");
  await assert.rejects(() => access(path.join(root, "audit-2020-01-01.jsonl")));
});
