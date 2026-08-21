import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export interface AuditEvent {
  timestamp?: string;
  requestId: string;
  serverId: string;
  action: string;
  outcome: "success" | "failure";
  durationMs: number;
  command?: string;
  localPath?: string;
  remotePath?: string;
  exitCode?: number | null;
  errorCode?: string;
}

export class AuditLogger {
  private lastRetentionCleanupDate: string | undefined;

  constructor(
    private readonly filePath: string,
    private readonly commandMode: "full" | "hash" = "full",
    private readonly retentionDays = 30,
  ) {}

  async write(event: AuditEvent): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const safe = {
      timestamp: event.timestamp ?? new Date().toISOString(),
      request_id: event.requestId,
      server_id: event.serverId,
      action: event.action,
      outcome: event.outcome,
      duration_ms: event.durationMs,
      ...(event.command
        ? {
            command:
              this.commandMode === "hash"
                ? `sha256:${createHash("sha256").update(event.command).digest("hex")}`
                : event.command,
          }
        : {}),
      ...(event.localPath ? { local_path: event.localPath } : {}),
      ...(event.remotePath ? { remote_path: event.remotePath } : {}),
      ...(event.exitCode !== undefined ? { exit_code: event.exitCode } : {}),
      ...(event.errorCode ? { error_code: event.errorCode } : {}),
    };
    const timestamp = String(safe.timestamp);
    const date = timestamp.slice(0, 10);
    await appendFile(this.dailyFile(date), `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
    if (this.lastRetentionCleanupDate !== date) {
      this.lastRetentionCleanupDate = date;
      await this.cleanupExpired(new Date(timestamp));
    }
  }

  async read(
    limitOrOptions: number | {
      limit?: number;
      serverId?: string;
      action?: string;
      since?: string;
      until?: string;
    } = 50,
  ): Promise<Array<Record<string, unknown>>> {
    const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
    const directory = path.dirname(this.filePath);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const baseName = path.basename(this.filePath, path.extname(this.filePath));
    const extension = path.extname(this.filePath);
    const matcher = new RegExp(`^${escapeRegex(baseName)}(?:-\\d{4}-\\d{2}-\\d{2})?${escapeRegex(extension)}$`);
    const events: Array<Record<string, unknown>> = [];
    for (const name of names.filter((candidate) => matcher.test(candidate)).sort()) {
      const content = await readFile(path.join(directory, name), "utf8");
      for (const line of content.split(/\r?\n/).filter(Boolean)) {
        const event = JSON.parse(line) as Record<string, unknown>;
        const timestamp = String(event.timestamp ?? "");
        if (options.serverId && event.server_id !== options.serverId) continue;
        if (options.action && event.action !== options.action) continue;
        if (options.since && timestamp < new Date(options.since).toISOString()) continue;
        if (options.until && timestamp > new Date(options.until).toISOString()) continue;
        events.push(event);
      }
    }
    return events.slice(-Math.max(1, options.limit ?? 50));
  }

  private dailyFile(date: string): string {
    const extension = path.extname(this.filePath);
    return path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath, extension)}-${date}${extension}`,
    );
  }

  private async cleanupExpired(now: Date): Promise<void> {
    const directory = path.dirname(this.filePath);
    const baseName = path.basename(this.filePath, path.extname(this.filePath));
    const extension = path.extname(this.filePath);
    const matcher = new RegExp(`^${escapeRegex(baseName)}-(\\d{4}-\\d{2}-\\d{2})${escapeRegex(extension)}$`);
    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - this.retentionDays);
    for (const name of await readdir(directory)) {
      const match = matcher.exec(name);
      if (!match?.[1]) continue;
      const fileDate = new Date(`${match[1]}T00:00:00.000Z`);
      if (fileDate < cutoff) await rm(path.join(directory, name), { force: true });
    }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
