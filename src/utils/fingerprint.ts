import { createHash, timingSafeEqual } from "node:crypto";

export function sha256Fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function readSshKeyAlgorithm(key: Buffer): string {
  if (key.length < 4) return "unknown";
  const length = key.readUInt32BE(0);
  if (length < 1 || length > key.length - 4) return "unknown";
  return key.subarray(4, 4 + length).toString("utf8");
}

export function fingerprintsEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
