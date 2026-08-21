import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { OperationsService } from "../services/operations.js";
import { normalizeError } from "../errors/app-error.js";
import { toPublicError } from "../errors/tool-error.js";

function content(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  return { ...content(toPublicError(normalizeError(error))), isError: true as const };
}

export async function runMcpServer(operations: OperationsService): Promise<void> {
  const server = new McpServer({ name: "ai-ops-mcp", version: "0.1.0" });

  server.registerTool("list_servers", { description: "List configured SSH server aliases and readiness without exposing credentials." }, async () => {
    try { return content({ servers: await operations.listServers() }); } catch (error) { return failure(error); }
  });

  server.registerTool("test_connection", {
    description: "Test a configured SSH server connection by server_id.",
    inputSchema: { server_id: z.string().min(1) },
  }, async ({ server_id }) => {
    try { return content(await operations.testConnection(server_id)); } catch (error) { return failure(error); }
  });

  server.registerTool("execute_command", {
    description: "Execute an arbitrary command on a configured SSH server. This tool does not classify command safety.",
    inputSchema: {
      server_id: z.string().min(1),
      command: z.string().min(1),
      cwd: z.string().min(1).optional(),
      timeout_ms: z.number().int().positive().optional(),
    },
  }, async ({ server_id, command, cwd, timeout_ms }) => {
    try {
      return content(await operations.runCommand({
        serverId: server_id,
        command,
        ...(cwd ? { cwd } : {}),
        ...(timeout_ms ? { timeoutMs: timeout_ms } : {}),
      }));
    } catch (error) { return failure(error); }
  });

  server.registerTool("upload_file", {
    description: "Upload a local file within allowed roots to a configured SSH server.",
    inputSchema: {
      server_id: z.string().min(1),
      local_path: z.string().min(1),
      remote_path: z.string().min(1),
    },
  }, async ({ server_id, local_path, remote_path }) => {
    try { return content(await operations.upload({ serverId: server_id, localPath: local_path, remotePath: remote_path })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("download_file", {
    description: "Download a remote file to a local path within allowed roots.",
    inputSchema: {
      server_id: z.string().min(1),
      remote_path: z.string().min(1),
      local_path: z.string().min(1),
      overwrite: z.boolean().optional(),
    },
  }, async ({ server_id, remote_path, local_path, overwrite }) => {
    try {
      return content(await operations.download({
        serverId: server_id,
        remotePath: remote_path,
        localPath: local_path,
        ...(overwrite !== undefined ? { overwrite } : {}),
      }));
    } catch (error) { return failure(error); }
  });

  server.registerTool("list_dir", {
    description: "List a remote directory on a configured SSH server.",
    inputSchema: { server_id: z.string().min(1), remote_path: z.string().min(1) },
  }, async ({ server_id, remote_path }) => {
    try { return content({ entries: await operations.listDir({ serverId: server_id, remotePath: remote_path }) }); }
    catch (error) { return failure(error); }
  });

  const shutdown = async () => {
    await operations.close();
    await server.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  process.stdin.once("end", () => void shutdown());
  await server.connect(new StdioServerTransport());
}
