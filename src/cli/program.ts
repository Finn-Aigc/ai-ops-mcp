import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import type { ServerConfig } from "../config/schema.js";
import { serverConfigSchema } from "../config/schema.js";
import { normalizeError } from "../errors/app-error.js";
import { probeHostKey } from "../ssh/host-key.js";
import { resolveAgentSocket } from "../credentials/providers.js";
import { runProcess } from "../credentials/process.js";
import type { createApplication } from "../app.js";
import { confirm, promptSecret, promptText } from "./prompts.js";
import { resolveSshHost } from "./ssh-config.js";

type Application = Awaited<ReturnType<typeof createApplication>>;

function credentialReference(serverId: string, kind: "password" | "passphrase"): string {
  return `server/${serverId}/${kind}`;
}

async function enrollHostKey(host: string, port: number): Promise<ServerConfig["hostKey"]> {
  process.stdout.write(`Probing SSH host key for ${host}:${port}...\n`);
  const hostKey = await probeHostKey(host, port);
  process.stdout.write(`Algorithm: ${hostKey.algorithm}\nFingerprint: ${hostKey.fingerprint}\n`);
  if (!(await confirm("Trust this host key"))) throw new Error("Host key was not trusted.");
  return hostKey;
}

export function createCli(app: Application): Command {
  const program = new Command();
  program.name("ai-ops").description("Local SSH credential broker for MCP").version("0.1.0");

  program.command("add")
    .description("Add an SSH server and store its credential outside config.json")
    .option("--id <id>")
    .option("--name <name>")
    .option("--host <host>")
    .option("--port <port>", "SSH port", "22")
    .option("--user <username>")
    .option("--auth <type>", "agent, password or private-key")
    .option("--key <path>", "private key path")
    .option("--group <group>")
    .action(async (options) => {
      const id = options.id ?? await promptText("Server ID");
      const name = options.name ?? await promptText("Name", id);
      const host = options.host ?? await promptText("Host");
      const port = Number.parseInt(options.port ?? await promptText("Port", "22"), 10);
      const username = options.user ?? await promptText("Username");
      const authType = (options.auth ?? await promptText("Auth (agent/password/private-key)", "agent")) as string;
      const hostKey = await enrollHostKey(host, port);
      let auth: ServerConfig["auth"];
      let createdSecretRef: string | undefined;
      try {
        if (authType === "password") {
          const password = await promptSecret("Password");
          const reference = credentialReference(id, "password");
          await app.secretStore.set(reference, password);
          createdSecretRef = reference;
          auth = { type: "systemCredential", credentialRef: reference };
        } else if (authType === "private-key") {
          const privateKeyPath = options.key ?? await promptText("Private key path");
          let passphraseRef: string | undefined;
          if (await confirm("Does this private key have a passphrase")) {
            const passphrase = await promptSecret("Private key passphrase");
            passphraseRef = credentialReference(id, "passphrase");
            await app.secretStore.set(passphraseRef, passphrase);
            createdSecretRef = passphraseRef;
          }
          auth = { type: "privateKey", privateKeyPath, ...(passphraseRef ? { passphraseRef } : {}) };
        } else if (authType === "agent") {
          auth = { type: "agent" };
        } else {
          throw new Error(`Unsupported auth type: ${authType}`);
        }
        const server = serverConfigSchema.parse({
          id, name, host, port, username, auth, hostKey,
          ...(options.group ? { group: options.group } : {}),
        });
        await app.repository.upsertServer(server);
        try {
          await app.operations.testConnection(id);
          process.stdout.write(`Server '${id}' added and connection test succeeded.\n`);
        } catch (error) {
          process.stdout.write(`Server '${id}' was saved, but connection test failed: ${normalizeError(error).message}\n`);
        }
      } catch (error) {
        if (createdSecretRef) await app.secretStore.delete(createdSecretRef).catch(() => undefined);
        throw error;
      }
    });

  program.command("import-ssh")
    .argument("<alias>")
    .description("Import host metadata from the effective OpenSSH config and use SSH Agent")
    .option("--id <id>")
    .option("--name <name>")
    .option("--config <path>", "custom OpenSSH config file")
    .action(async (alias, options) => {
      const resolved = await resolveSshHost(alias, options.config);
      const id = options.id ?? alias;
      const hostKey = await enrollHostKey(resolved.host, resolved.port);
      const server = serverConfigSchema.parse({
        id,
        name: options.name ?? alias,
        host: resolved.host,
        port: resolved.port,
        username: resolved.username,
        auth: { type: "agent" },
        hostKey,
      });
      await app.repository.upsertServer(server);
      await app.operations.testConnection(id);
      process.stdout.write(`Imported '${alias}' as '${id}'.\n`);
    });

  program.command("list").description("List configured servers").option("--json").action(async (options) => {
    const servers = await app.operations.listServers();
    if (options.json) process.stdout.write(`${JSON.stringify(servers, null, 2)}\n`);
    else if (servers.length === 0) process.stdout.write("No servers configured.\n");
    else for (const server of servers) process.stdout.write(`${server.id}\t${server.name}\t${server.auth_status}\n`);
  });

  program.command("show").argument("<id>").description("Show non-secret server metadata").action(async (id) => {
    const server = await app.repository.getServer(id);
    process.stdout.write(`${JSON.stringify(server, null, 2)}\n`);
  });

  program.command("test").argument("<id>").description("Test an SSH connection").action(async (id) => {
    process.stdout.write(`${JSON.stringify(await app.operations.testConnection(id), null, 2)}\n`);
  });

  program.command("edit").argument("<id>").description("Update a stored password or private-key passphrase")
    .option("--password", "replace the stored SSH password")
    .option("--passphrase", "replace the stored private-key passphrase")
    .option("--name <name>", "replace the display name")
    .option("--host <host>", "replace the SSH host")
    .option("--port <port>", "replace the SSH port")
    .option("--user <username>", "replace the SSH username")
    .option("--group <group>", "replace the server group")
    .option("--clear-group", "remove the server group")
    .option("--allowed-local <paths...>", "replace allowed local roots")
    .option("--allowed-remote <paths...>", "replace allowed remote roots")
    .action(async (id, options) => {
      let server = await app.repository.getServer(id);
      let changed = false;
      if (options.password) {
        if (server.auth.type !== "systemCredential") throw new Error("Server does not use password authentication.");
        await app.secretStore.set(server.auth.credentialRef, await promptSecret("New password"));
        changed = true;
      }
      if (options.passphrase) {
        if (server.auth.type !== "privateKey") throw new Error("Server does not use a private key.");
        const reference = server.auth.passphraseRef ?? credentialReference(id, "passphrase");
        await app.secretStore.set(reference, await promptSecret("New private-key passphrase"));
        if (!server.auth.passphraseRef) {
          await app.repository.upsertServer({ ...server, auth: { ...server.auth, passphraseRef: reference } });
          server = await app.repository.getServer(id);
        }
        changed = true;
      }
      const nextHost = options.host ?? server.host;
      const nextPort = options.port ? Number.parseInt(options.port, 10) : server.port;
      const targetChanged = nextHost !== server.host || nextPort !== server.port;
      const metadataChanged = Boolean(
        options.name || options.host || options.port || options.user || options.group || options.clearGroup ||
        options.allowedLocal || options.allowedRemote,
      );
      if (metadataChanged) {
        const hostKey = targetChanged ? await enrollHostKey(nextHost, nextPort) : server.hostKey;
        server = serverConfigSchema.parse({
          ...server,
          name: options.name ?? server.name,
          host: nextHost,
          port: nextPort,
          username: options.user ?? server.username,
          ...((options.clearGroup || (!options.group && !server.group))
            ? { group: undefined }
            : { group: options.group ?? server.group }),
          hostKey,
          allowedLocalPaths: options.allowedLocal ?? server.allowedLocalPaths,
          allowedRemotePaths: options.allowedRemote ?? server.allowedRemotePaths,
        });
        await app.repository.upsertServer(server);
        changed = true;
      }
      if (!changed) throw new Error("No edit option was provided.");
      await app.pool.invalidate(id);
      process.stdout.write(`Server '${id}' updated.\n`);
    });

  program.command("remove").argument("<id>").description("Remove a server and its stored credential").option("--yes").action(async (id, options) => {
    const server = await app.repository.getServer(id);
    if (!options.yes && !(await confirm(`Remove server '${id}' and its stored credential`))) return;
    await app.repository.removeServer(id);
    if (server.auth.type === "systemCredential") await app.secretStore.delete(server.auth.credentialRef);
    if (server.auth.type === "privateKey" && server.auth.passphraseRef) await app.secretStore.delete(server.auth.passphraseRef);
    await app.pool.invalidate(id);
    process.stdout.write(`Removed '${id}'.\n`);
  });

  program.command("trust-host").argument("<id>").description("Replace a server's trusted Host key after verification").action(async (id) => {
    const server = await app.repository.getServer(id);
    const next = await probeHostKey(server.host, server.port);
    process.stdout.write(`Old: ${server.hostKey.fingerprint}\nNew: ${next.fingerprint}\n`);
    if (!(await confirm("Replace the trusted Host key"))) return;
    await app.repository.upsertServer({ ...server, hostKey: next });
    await app.pool.invalidate(id);
    await app.audit.write({ requestId: randomUUID(), serverId: id, action: "host_key_replaced", outcome: "success", durationMs: 0 });
    process.stdout.write(`Trusted Host key for '${id}' updated.\n`);
  });

  program.command("doctor").description("Diagnose credential, Agent and configuration readiness").option("--json").action(async (options) => {
    const config = await app.repository.load();
    const checks: Array<Record<string, unknown>> = [];
    checks.push({ name: "node", status: Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "error", message: process.version });
    checks.push({ name: "credential_store", ...(await app.secretStore.diagnose()) });
    try {
      const configStat = await stat(app.paths.configFile);
      checks.push({
        name: "config_file",
        status: process.platform === "win32" || (configStat.mode & 0o077) === 0 ? "ok" : "warn",
        message: process.platform === "win32"
          ? `${app.paths.configFile} (private Windows ACL managed by ai-ops)`
          : `${app.paths.configFile} (${(configStat.mode & 0o777).toString(8)})`,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        checks.push({ name: "config_file", status: "warn", message: "Config file has not been created yet." });
      } else {
        checks.push({ name: "config_file", status: "error", message: "Config file is not readable." });
      }
    }
    try {
      await mkdir(app.paths.dataDir, { recursive: true, mode: 0o700 });
      await access(app.paths.dataDir, constants.R_OK | constants.W_OK);
      checks.push({ name: "audit_directory", status: "ok", message: app.paths.dataDir });
    } catch {
      checks.push({ name: "audit_directory", status: "error", message: "Audit directory is not readable and writable." });
    }
    const agentSocket = resolveAgentSocket();
    try {
      const agent = await runProcess("ssh-add", ["-l"]);
      checks.push({ name: "ssh_agent", status: agent.exitCode === 0 ? "ok" : "warn", message: agent.stdout.trim() || agent.stderr.trim() || agentSocket || "unavailable" });
    } catch {
      checks.push({ name: "ssh_agent", status: "error", message: "ssh-add is unavailable." });
    }
    for (const server of config.servers) checks.push({ name: `server:${server.id}`, ...(await app.credentials.diagnose(server)) });
    if (options.json) process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
    else for (const check of checks) process.stdout.write(`${String(check.status).toUpperCase()}\t${check.name}\t${check.message}\n`);
  });

  program.command("logs").description("Show recent audit events")
    .option("--limit <number>", "number of events", "50")
    .option("--server <id>", "filter by server ID")
    .option("--action <action>", "filter by action")
    .option("--since <time>", "include events at or after this ISO timestamp")
    .option("--until <time>", "include events at or before this ISO timestamp")
    .action(async (options) => {
      process.stdout.write(`${JSON.stringify(await app.audit.read({
        limit: Number.parseInt(options.limit, 10),
        ...(options.server ? { serverId: options.server } : {}),
        ...(options.action ? { action: options.action } : {}),
        ...(options.since ? { since: options.since } : {}),
        ...(options.until ? { until: options.until } : {}),
      }), null, 2)}\n`);
    });

  return program;
}
