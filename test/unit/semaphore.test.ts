import test from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "../../src/ssh/semaphore.js";

test("semaphore rejects beyond its limit and recovers after release", () => {
  const semaphore = new Semaphore(1);
  const release = semaphore.acquire();
  assert.throws(() => semaphore.acquire(), (error) => error?.code === "CONCURRENCY_LIMIT");
  release();
  const releaseAgain = semaphore.acquire();
  releaseAgain();
});
