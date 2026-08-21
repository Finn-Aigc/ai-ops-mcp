import type { Client } from "ssh2";
import { AppError } from "../errors/app-error.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  truncated: boolean;
}

export function quotePosix(value: string): string {
  if (value.includes("\0")) throw new AppError("CONFIG_INVALID", "Working directory contains a null byte.");
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function executeCommand(
  client: Client,
  command: string,
  options: { cwd?: string; timeoutMs: number; maxOutputBytes: number },
): Promise<CommandResult> {
  const remoteCommand = options.cwd ? `cd -- ${quotePosix(options.cwd)} && ${command}` : command;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    client.exec(remoteCommand, (error, stream) => {
      if (error) return reject(error);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let exitCode: number | null = null;
      let signal: string | null = null;
      let settled = false;
      const timer = setTimeout(() => {
        stream.close();
        if (!settled) {
          settled = true;
          reject(new AppError("COMMAND_TIMEOUT", `Command timed out after ${options.timeoutMs}ms.`, { retriable: false }));
        }
      }, options.timeoutMs);
      const capture = (target: Buffer[], chunk: Buffer) => {
        if (settled) return;
        const remaining = options.maxOutputBytes === 0 ? chunk.length : Math.max(0, options.maxOutputBytes - bytes);
        if (options.maxOutputBytes === 0 || chunk.length <= remaining) {
          target.push(chunk);
          bytes += chunk.length;
          return;
        }
        if (remaining > 0) target.push(chunk.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        stream.close();
      };
      stream.on("data", (chunk: Buffer) => capture(stdout, chunk));
      stream.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      stream.on("exit", (code: number | undefined, exitSignal: string | undefined) => {
        exitCode = code ?? null;
        signal = exitSignal ?? null;
      });
      stream.once("close", () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode,
          signal,
          durationMs: Date.now() - started,
          truncated,
        });
      });
    });
  });
}
