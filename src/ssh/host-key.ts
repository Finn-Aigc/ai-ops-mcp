import { Client } from "ssh2";
import type { ServerConfig } from "../config/schema.js";
import { AppError } from "../errors/app-error.js";
import { fingerprintsEqual, readSshKeyAlgorithm, sha256Fingerprint } from "../utils/fingerprint.js";

export interface HostKeyInfo {
  algorithm: string;
  fingerprint: string;
}

export function verifyHostKey(server: ServerConfig, key: Buffer): boolean {
  return fingerprintsEqual(sha256Fingerprint(key), server.hostKey.fingerprint);
}

export function probeHostKey(host: string, port: number, timeoutMs = 15_000): Promise<HostKeyInfo> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const timer = setTimeout(() => finish(new AppError("SSH_CONNECTION_TIMEOUT", `Timed out probing ${host}:${port}.`, { retriable: true })), timeoutMs);
    const finish = (error?: Error, info?: HostKeyInfo) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      if (error) reject(error);
      else resolve(info!);
    };
    client.once("error", (error) => {
      if (!settled) finish(error);
    });
    client.connect({
      host,
      port,
      username: "ai-ops-host-key-probe",
      readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer) => {
        const buffer = Buffer.from(key);
        finish(undefined, {
          algorithm: readSshKeyAlgorithm(buffer),
          fingerprint: sha256Fingerprint(buffer),
        });
        return false;
      },
    });
  });
}
