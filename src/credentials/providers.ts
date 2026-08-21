import { readFile } from "node:fs/promises";
import { createAgent, type ParsedKey } from "ssh2";
import type { ServerConfig } from "../config/schema.js";
import { AppError } from "../errors/app-error.js";
import type {
  CredentialDiagnosis,
  CredentialProvider,
  ResolvedCredential,
  SecretStore,
} from "./types.js";
import { sha256Fingerprint } from "../utils/fingerprint.js";

export class AgentCredentialProvider implements CredentialProvider {
  supports(server: ServerConfig): boolean {
    return server.auth.type === "agent";
  }

  async resolve(server: ServerConfig): Promise<ResolvedCredential> {
    const agentSocket = resolveAgentSocket();
    if (!agentSocket) {
      throw new AppError("AGENT_UNAVAILABLE", "SSH Agent is not available.", {
        action: "Run ai-ops doctor and start your system SSH Agent.",
      });
    }
    const fingerprint = server.auth.type === "agent" ? server.auth.publicKeyFingerprint : undefined;
    return {
      type: "agent",
      agentSocket,
      ...(fingerprint ? { publicKeyFingerprint: fingerprint } : {}),
    };
  }

  async diagnose(_server: ServerConfig): Promise<CredentialDiagnosis> {
    const socket = resolveAgentSocket();
    if (!socket) return { status: "error", message: "SSH Agent endpoint is not available." };
    try {
      const fingerprints = await listAgentFingerprints(socket);
      const expected = _server.auth.type === "agent" ? _server.auth.publicKeyFingerprint : undefined;
      if (expected && !fingerprints.includes(expected)) {
        return { status: "error", message: `Configured SSH Agent identity '${expected}' is not loaded.` };
      }
      if (fingerprints.length === 0) return { status: "warn", message: "SSH Agent is available but has no identities." };
      return { status: "ok", message: `SSH Agent is available with ${fingerprints.length} identity/identities.` };
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : "SSH Agent lookup failed." };
    }
  }
}

export class SystemCredentialProvider implements CredentialProvider {
  constructor(private readonly store: SecretStore) {}

  supports(server: ServerConfig): boolean {
    return server.auth.type === "systemCredential";
  }

  async resolve(server: ServerConfig): Promise<ResolvedCredential> {
    if (server.auth.type !== "systemCredential") throw new Error("Unsupported auth config");
    const password = await this.store.get(server.auth.credentialRef);
    if (password === null) {
      throw new AppError("CREDENTIAL_NOT_FOUND", `Credential for '${server.id}' was not found.`, {
        action: `Run ai-ops edit ${server.id} to store it again.`,
      });
    }
    return { type: "password", password };
  }

  async diagnose(server: ServerConfig): Promise<CredentialDiagnosis> {
    if (server.auth.type !== "systemCredential") return { status: "error", message: "Unsupported auth config." };
    try {
      const value = await this.store.get(server.auth.credentialRef);
      return value === null
        ? { status: "error", message: "Credential is missing." }
        : { status: "ok", message: "Credential is available." };
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : "Credential lookup failed." };
    }
  }
}

export class PrivateKeyCredentialProvider implements CredentialProvider {
  constructor(private readonly store: SecretStore) {}

  supports(server: ServerConfig): boolean {
    return server.auth.type === "privateKey";
  }

  async resolve(server: ServerConfig): Promise<ResolvedCredential> {
    if (server.auth.type !== "privateKey") throw new Error("Unsupported auth config");
    let privateKey: Buffer;
    try {
      privateKey = await readFile(server.auth.privateKeyPath);
    } catch (error) {
      throw new AppError("CREDENTIAL_NOT_FOUND", `Private key file cannot be read for '${server.id}'.`, { cause: error });
    }
    const passphrase = server.auth.passphraseRef
      ? await this.store.get(server.auth.passphraseRef)
      : null;
    return {
      type: "privateKey",
      privateKey,
      ...(passphrase !== null ? { passphrase } : {}),
    };
  }

  async diagnose(server: ServerConfig): Promise<CredentialDiagnosis> {
    if (server.auth.type !== "privateKey") return { status: "error", message: "Unsupported auth config." };
    try {
      await readFile(server.auth.privateKeyPath);
      return { status: "ok", message: "Private key file is readable." };
    } catch {
      return { status: "error", message: "Private key file is not readable." };
    }
  }
}

export class CredentialResolver {
  constructor(private readonly providers: CredentialProvider[]) {}

  resolve(server: ServerConfig): Promise<ResolvedCredential> {
    const provider = this.providers.find((candidate) => candidate.supports(server));
    if (!provider) throw new AppError("CREDENTIAL_STORE_UNAVAILABLE", `No credential provider supports '${server.auth.type}'.`);
    return provider.resolve(server);
  }

  diagnose(server: ServerConfig): Promise<CredentialDiagnosis> {
    const provider = this.providers.find((candidate) => candidate.supports(server));
    if (!provider) return Promise.resolve({ status: "error", message: `No provider for '${server.auth.type}'.` });
    return provider.diagnose(server);
  }
}

export function resolveAgentSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SSH_AUTH_SOCK) return env.SSH_AUTH_SOCK;
  if (process.platform === "win32") return "\\\\.\\pipe\\openssh-ssh-agent";
  return undefined;
}

function listAgentFingerprints(socket: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError("AGENT_UNAVAILABLE", "SSH Agent identity lookup timed out.")), 5_000);
    createAgent(socket).getIdentities((error, keys) => {
      clearTimeout(timer);
      if (error) return reject(new AppError("AGENT_UNAVAILABLE", `SSH Agent is unavailable: ${error.message}`, { cause: error }));
      const fingerprints = (keys ?? [])
        .filter((key): key is ParsedKey => typeof key === "object" && "getPublicSSH" in key)
        .map((key) => sha256Fingerprint(key.getPublicSSH()));
      resolve(fingerprints);
    });
  });
}
