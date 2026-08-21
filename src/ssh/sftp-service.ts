import { constants } from "node:fs";
import { access, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Client, SFTPWrapper } from "ssh2";
import { AppError } from "../errors/app-error.js";

function getSftp(client: Client, timeoutMs: number): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError("SFTP_TIMEOUT", "Timed out opening SFTP session.", { retriable: true })), timeoutMs);
    client.sftp((error, sftp) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

function withCallback(timeoutMs: number, operation: (done: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError("SFTP_TIMEOUT", "SFTP operation timed out.", { retriable: true })), timeoutMs);
    operation((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function uploadFile(
  client: Client,
  localPath: string,
  remotePath: string,
  timeoutMs: number,
  maxFileBytes: number,
): Promise<void> {
  const localStat = await stat(localPath);
  if (localStat.size > maxFileBytes) {
    throw new AppError("FILE_SIZE_LIMIT_EXCEEDED", `Local file exceeds the configured ${maxFileBytes}-byte transfer limit.`);
  }
  const sftp = await getSftp(client, timeoutMs);
  try {
    await withCallback(timeoutMs, (done) => sftp.fastPut(localPath, remotePath, done));
  } finally {
    sftp.end();
  }
}

export async function downloadFile(
  client: Client,
  remotePath: string,
  localPath: string,
  timeoutMs: number,
  overwrite: boolean,
  maxFileBytes: number,
): Promise<void> {
  if (!overwrite) {
    try {
      await access(localPath, constants.F_OK);
      throw new AppError("LOCAL_FILE_EXISTS", `Local file already exists: ${localPath}`);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const sftp = await getSftp(client, timeoutMs);
  try {
    const remoteSize = await new Promise<number>((resolve, reject) => {
      sftp.stat(remotePath, (error, attributes) => {
        if (error) reject(error);
        else resolve(attributes.size);
      });
    });
    if (remoteSize > maxFileBytes) {
      throw new AppError("FILE_SIZE_LIMIT_EXCEEDED", `Remote file exceeds the configured ${maxFileBytes}-byte transfer limit.`);
    }
    try {
      await withCallback(timeoutMs, (done) => sftp.fastGet(remotePath, localPath, done));
    } catch (error) {
      if (!overwrite) await rm(localPath, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    sftp.end();
  }
}

export async function listDirectory(client: Client, remotePath: string, timeoutMs: number): Promise<Array<Record<string, unknown>>> {
  const sftp = await getSftp(client, timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError("SFTP_TIMEOUT", "Directory listing timed out.", { retriable: true })), timeoutMs);
      sftp.readdir(remotePath, (error, entries) => {
        clearTimeout(timer);
        if (error) return reject(error);
        resolve(entries.map((entry) => ({
          name: entry.filename,
          longname: entry.longname,
          size: entry.attrs.size,
          mode: entry.attrs.mode,
          mtime: new Date(entry.attrs.mtime * 1000).toISOString(),
          path: path.posix.join(remotePath, entry.filename),
        })));
      });
    });
  } finally {
    sftp.end();
  }
}
