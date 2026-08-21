import {
  BaseAgent,
  Client,
  createAgent,
  type ConnectConfig,
  type GetStreamCallback,
  type IdentityCallback,
  type ParsedKey,
  type SignCallback,
  type SigningRequestOptions,
} from "ssh2";
import type { ServerConfig } from "../config/schema.js";
import { AppError } from "../errors/app-error.js";
import type { CredentialResolver } from "../credentials/providers.js";
import type { ResolvedCredential } from "../credentials/types.js";
import { verifyHostKey } from "./host-key.js";
import { sha256Fingerprint } from "../utils/fingerprint.js";

interface PooledConnection {
  client: Client;
  signature: string;
}

export class ConnectionPool {
  private readonly connections = new Map<string, PooledConnection>();
  private readonly pending = new Map<string, Promise<Client>>();

  constructor(private readonly credentials: CredentialResolver) {}

  async acquire(server: ServerConfig): Promise<Client> {
    const signature = JSON.stringify([server.host, server.port, server.username, server.auth, server.hostKey]);
    const existing = this.connections.get(server.id);
    if (existing?.signature === signature) return existing.client;
    if (existing) await this.invalidate(server.id);
    const inFlight = this.pending.get(server.id);
    if (inFlight) return inFlight;
    const connecting = this.connect(server, signature).finally(() => this.pending.delete(server.id));
    this.pending.set(server.id, connecting);
    return connecting;
  }

  async invalidate(serverId: string): Promise<void> {
    const existing = this.connections.get(serverId);
    this.connections.delete(serverId);
    existing?.client.end();
  }

  isConnected(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  async closeAll(): Promise<void> {
    for (const connection of this.connections.values()) connection.client.end();
    this.connections.clear();
  }

  private async connect(server: ServerConfig, signature: string): Promise<Client> {
    const credential = await this.credentials.resolve(server);
    let hostKeyRejected = false;
    const config = this.buildConfig(server, credential, () => {
      hostKeyRejected = true;
    });
    return new Promise((resolve, reject) => {
      const client = new Client();
      let connected = false;
      let settled = false;
      const clearPrivateKey = () => {
        if (credential.type === "privateKey") credential.privateKey.fill(0);
      };
      client.once("ready", () => {
        if (settled) return;
        settled = true;
        connected = true;
        clearPrivateKey();
        this.connections.set(server.id, { client, signature });
        resolve(client);
      });
      client.on("error", (error) => {
        clearPrivateKey();
        if (!connected && !settled) {
          settled = true;
          reject(this.classifyConnectionError(server, error, hostKeyRejected));
        }
      });
      client.once("close", () => this.connections.delete(server.id));
      try {
        client.connect(config);
      } catch (error) {
        clearPrivateKey();
        if (!settled) {
          settled = true;
          reject(this.classifyConnectionError(server, error, hostKeyRejected));
        }
      }
    });
  }

  private classifyConnectionError(
    server: ServerConfig,
    error: unknown,
    hostKeyRejected: boolean,
  ): AppError {
    if (error instanceof AppError) return error;
    const source = error instanceof Error ? error : new Error(String(error));
    const message = source.message.toLowerCase();
    if (hostKeyRejected) {
      return new AppError("HOST_KEY_MISMATCH", `Host key mismatch for '${server.id}'.`, {
        action: `Verify the server and run ai-ops trust-host ${server.id}.`,
        cause: source,
      });
    }
    if (
      message.includes("authentication") ||
      message.includes("privatekey") ||
      message.includes("private key") ||
      message.includes("passphrase") ||
      message.includes("bad decrypt")
    ) {
      return new AppError("SSH_AUTHENTICATION_FAILED", `SSH authentication failed for '${server.id}'.`, {
        cause: source,
      });
    }
    return new AppError(
      "SSH_CONNECTION_TIMEOUT",
      `SSH connection failed for '${server.id}': ${source.message}`,
      { retriable: true, cause: source },
    );
  }

  private buildConfig(
    server: ServerConfig,
    credential: ResolvedCredential,
    onHostKeyRejected: () => void,
  ): ConnectConfig {
    const base: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: 30_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        const accepted = verifyHostKey(server, Buffer.from(key));
        if (!accepted) onHostKeyRejected();
        return accepted;
      },
    };
    if (credential.type === "agent") {
      return {
        ...base,
        agent: credential.publicKeyFingerprint
          ? new FingerprintAgent(credential.agentSocket, credential.publicKeyFingerprint)
          : credential.agentSocket,
      };
    }
    if (credential.type === "password") return { ...base, password: credential.password };
    return {
      ...base,
      privateKey: credential.privateKey,
      ...(credential.passphrase ? { passphrase: credential.passphrase } : {}),
    };
  }
}

class FingerprintAgent extends BaseAgent<ParsedKey> {
  private readonly delegate: BaseAgent;

  constructor(socketPath: string, private readonly fingerprint: string) {
    super();
    this.delegate = createAgent(socketPath);
  }

  getIdentities(callback: IdentityCallback<ParsedKey>): void {
    this.delegate.getIdentities((error, keys) => {
      if (error) return callback(error);
      const parsedKeys = (keys ?? []).filter((key): key is ParsedKey => typeof key === "object" && "getPublicSSH" in key);
      const matches = parsedKeys.filter((key) => sha256Fingerprint(key.getPublicSSH()) === this.fingerprint);
      if (matches.length === 0) {
        return callback(new AppError("AGENT_IDENTITY_NOT_FOUND", `SSH Agent identity '${this.fingerprint}' was not found.`));
      }
      callback(null, matches);
    });
  }

  sign(pubKey: ParsedKey, data: Buffer, callback: SignCallback): void;
  sign(pubKey: ParsedKey, data: Buffer, options: SigningRequestOptions, callback?: SignCallback): void;
  sign(
    pubKey: ParsedKey,
    data: Buffer,
    optionsOrCallback: SigningRequestOptions | SignCallback,
    callback?: SignCallback,
  ): void {
    if (typeof optionsOrCallback === "function") this.delegate.sign(pubKey, data, optionsOrCallback);
    else this.delegate.sign(pubKey, data, optionsOrCallback, callback);
  }

  getStream(callback: GetStreamCallback): void {
    if (!this.delegate.getStream) return callback(new Error("Agent forwarding is unavailable."));
    this.delegate.getStream(callback);
  }
}
