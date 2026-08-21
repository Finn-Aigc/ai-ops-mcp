import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors/app-error.js";
import {
  appConfigSchema,
  assertNoSecretFields,
  type AppConfig,
  type ServerConfig,
} from "./schema.js";
import { applyPrivateFilePermissions } from "./permissions.js";

export class ConfigRepository {
  constructor(public readonly filePath: string) {}

  async load(): Promise<AppConfig> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return appConfigSchema.parse({ version: 1, servers: [] });
      }
      throw new AppError("CONFIG_INVALID", `Unable to read config: ${this.filePath}`, {
        cause: error,
      });
    }

    try {
      const value: unknown = JSON.parse(raw);
      assertNoSecretFields(value);
      return appConfigSchema.parse(value);
    } catch (error) {
      throw new AppError("CONFIG_INVALID", `Invalid config: ${this.filePath}`, {
        cause: error,
      });
    }
  }

  async save(config: AppConfig): Promise<void> {
    assertNoSecretFields(config);
    const normalized = appConfigSchema.parse(config);
    const directory = path.dirname(this.filePath);
    const temporary = path.join(directory, `.config.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await applyPrivateFilePermissions(temporary);
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async getServer(id: string): Promise<ServerConfig> {
    const config = await this.load();
    const server = config.servers.find((item) => item.id === id);
    if (!server) throw new AppError("SERVER_NOT_FOUND", `Server '${id}' is not configured.`);
    return server;
  }

  async upsertServer(server: ServerConfig): Promise<void> {
    const config = await this.load();
    const index = config.servers.findIndex((item) => item.id === server.id);
    if (index >= 0) config.servers[index] = server;
    else config.servers.push(server);
    await this.save(config);
  }

  async removeServer(id: string): Promise<ServerConfig> {
    const config = await this.load();
    const index = config.servers.findIndex((item) => item.id === id);
    if (index < 0) throw new AppError("SERVER_NOT_FOUND", `Server '${id}' is not configured.`);
    const [removed] = config.servers.splice(index, 1);
    await this.save(config);
    return removed!;
  }
}
