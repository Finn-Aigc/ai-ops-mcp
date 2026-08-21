import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateLocalPath, validateRemotePath } from "../../src/utils/path-boundary.js";

test("local path stays inside allowed root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-ops-test-"));
  await writeFile(path.join(root, "ok.txt"), "ok");
  assert.equal(await validateLocalPath(path.join(root, "ok.txt"), [root], "read"), path.join(root, "ok.txt"));
  await assert.rejects(() => validateLocalPath(path.join(root, "..", "outside.txt"), [root], "read"), /outside|does not exist/);
});

test("write path requires existing parent and remains inside root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-ops-test-"));
  await mkdir(path.join(root, "nested"));
  assert.equal(await validateLocalPath(path.join(root, "nested", "new.txt"), [root], "write"), path.join(root, "nested", "new.txt"));
  await assert.rejects(() => validateLocalPath(path.join(root, "missing", "new.txt"), [root], "write"), /parent directory/);
});

test("remote path uses POSIX boundaries", () => {
  assert.equal(validateRemotePath("/srv/app/../app/log.txt", ["/srv/app"]), "/srv/app/log.txt");
  assert.throws(() => validateRemotePath("/srv/application/x", ["/srv/app"]), /outside/);
});
