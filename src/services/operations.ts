import { randomUUID } from "node:crypto";
import process from "node:process";
import type { ConfigRepository } from "../config/repository.js";
import type { AppConfig, ServerConfig } from "../config/schema.js";
import type { AuditLogger } from "../audit/logger.js";
import type { CredentialResolver } from "../credentials/providers.js";
import { AppError, normalizeError } from "../errors/app-error.js";
import type { ConnectionPool } from "../ssh/connection-pool.js";
import { executeCommand, type CommandResult } from "../ssh/executor.js";
import { downloadFile, listDirectory, uploadFile } from "../ssh/sftp-service.js";
import { Semaphore } from "../ssh/semaphore.js";
import { validateLocalPath, validateRemotePath } from "../utils/path-boundary.js";

export class OperationsService {
  private readonly semaphores = new Map<string, { limit: number; semaphore: Semaphore }>();
  private globalSemaphore: { limit: number; semaphore: Semaphore } | undefined;

  constructor(
    private readonly repository: ConfigRepository,
    private readonly credentials: CredentialResolver,
    private readonly pool: ConnectionPool,
    private readonly audit: AuditLogger,
  ) {}

  async listServers(): Promise<Array<Record<string, unknown>>> {
    const config = await this.repository.load();
    return Promise.all(config.servers.map(async (server) => {
      const diagnosis = await this.credentials.diagnose(server);
      return {
        id: server.id,
        name: server.name,
        ...(server.group ? { group: server.group } : {}),
        connected: this.pool.isConnected(server.id),
        auth_status: diagnosis.status,
        ...(config.defaults.exposeConnectionMetadata
          ? { host: server.host, port: server.port, username: server.username }
          : {}),
      };
    }));
  }

  async testConnection(serverId: string): Promise<{ connected: true; latencyMs: number }> {
    const started = Date.now();
    await this.runAudited(serverId, "test_connection", async (server) => {
      await this.pool.acquire(server);
      return undefined;
    });
    return { connected: true, latencyMs: Date.now() - started };
  }

  async runCommand(input: {
    serverId: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
  }): Promise<CommandResult> {
    return this.runAudited(input.serverId, "execute_command", async (server, config) => {
      const client = await this.pool.acquire(server);
      const result = await executeCommand(client, input.command, {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        timeoutMs: this.clampTimeout(input.timeoutMs, server.limits?.commandTimeoutMs ?? config.defaults.commandTimeoutMs),
        maxOutputBytes: server.limits?.maxOutputBytes ?? config.defaults.maxOutputBytes,
      });
      return result;
    }, { command: input.command });
  }

  async upload(input: { serverId: string; localPath: string; remotePath: string }): Promise<{ success: true }> {
    return this.runAudited(input.serverId, "upload_file", async (server, config) => {
      const localPath = await validateLocalPath(input.localPath, this.localRoots(server), "read");
      const remotePath = validateRemotePath(input.remotePath, server.allowedRemotePaths ?? []);
      const client = await this.pool.acquire(server);
      await uploadFile(
        client,
        localPath,
        remotePath,
        server.limits?.sftpTimeoutMs ?? config.defaults.sftpTimeoutMs,
        server.limits?.maxFileBytes ?? config.defaults.maxFileBytes,
      );
      return { success: true as const };
    }, { localPath: input.localPath, remotePath: input.remotePath });
  }

  async download(input: {
    serverId: string;
    remotePath: string;
    localPath: string;
    overwrite?: boolean;
  }): Promise<{ success: true }> {
    return this.runAudited(input.serverId, "download_file", async (server, config) => {
      const remotePath = validateRemotePath(input.remotePath, server.allowedRemotePaths ?? []);
      const localPath = await validateLocalPath(input.localPath, this.localRoots(server), "write");
      const client = await this.pool.acquire(server);
      await downloadFile(
        client,
        remotePath,
        localPath,
        server.limits?.sftpTimeoutMs ?? config.defaults.sftpTimeoutMs,
        input.overwrite ?? false,
        server.limits?.maxFileBytes ?? config.defaults.maxFileBytes,
      );
      return { success: true as const };
    }, { localPath: input.localPath, remotePath: input.remotePath });
  }

  async listDir(input: { serverId: string; remotePath: string }): Promise<Array<Record<string, unknown>>> {
    return this.runAudited(input.serverId, "list_dir", async (server, config) => {
      const remotePath = validateRemotePath(input.remotePath, server.allowedRemotePaths ?? []);
      const client = await this.pool.acquire(server);
      return listDirectory(client, remotePath, server.limits?.sftpTimeoutMs ?? config.defaults.sftpTimeoutMs);
    }, { remotePath: input.remotePath });
  }

  async close(): Promise<void> {
    await this.pool.closeAll();
  }

  private localRoots(server: ServerConfig): string[] {
    return [process.cwd(), ...(server.allowedLocalPaths ?? [])];
  }

  private clampTimeout(requested: number | undefined, configured: number): number {
    if (requested === undefined) return configured;
    if (requested <= 0) throw new AppError("CONFIG_INVALID", "timeout_ms must be positive.");
    return Math.min(requested, configured);
  }

  private semaphore(server: ServerConfig, config: AppConfig): Semaphore {
    const limit = server.limits?.maxChannels ?? config.defaults.maxChannelsPerServer;
    let entry = this.semaphores.get(server.id);
    if (!entry || entry.limit !== limit) {
      entry = { limit, semaphore: new Semaphore(limit) };
      this.semaphores.set(server.id, entry);
    }
    return entry.semaphore;
  }

  private getGlobalSemaphore(config: AppConfig): Semaphore {
    const limit = config.defaults.maxGlobalChannels;
    if (!this.globalSemaphore || this.globalSemaphore.limit !== limit) {
      this.globalSemaphore = { limit, semaphore: new Semaphore(limit) };
    }
    return this.globalSemaphore.semaphore;
  }

  private async runAudited<T>(
    serverId: string,
    action: string,
    operation: (server: ServerConfig, config: AppConfig) => Promise<T>,
    details: { command?: string; localPath?: string; remotePath?: string } = {},
  ): Promise<T> {
    const requestId = randomUUID();
    const started = Date.now();
    const config = await this.repository.load();
    const server = config.servers.find((item) => item.id === serverId);
    if (!server) throw new AppError("SERVER_NOT_FOUND", `Server '${serverId}' is not configured.`);
    const releaseGlobal = this.getGlobalSemaphore(config).acquire();
    let releaseServer: (() => void) | undefined;
    try {
      releaseServer = this.semaphore(server, config).acquire();
      const result = await operation(server, config);
      await this.audit.write({
        requestId,
        serverId,
        action,
        outcome: "success",
        durationMs: Date.now() - started,
        ...details,
        ...(typeof result === "object" && result && "exitCode" in result
          ? { exitCode: (result as { exitCode: number | null }).exitCode }
          : {}),
      });
      return result;
    } catch (error) {
      const normalized = normalizeError(error);
      await this.audit.write({
        requestId,
        serverId,
        action,
        outcome: "failure",
        durationMs: Date.now() - started,
        ...details,
        errorCode: normalized.code,
      }).catch(() => undefined);
      throw normalized;
    } finally {
      releaseServer?.();
      releaseGlobal();
    }
  }
}
