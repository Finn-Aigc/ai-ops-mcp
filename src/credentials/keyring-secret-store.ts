import { AsyncEntry } from "@napi-rs/keyring";
import { AppError } from "../errors/app-error.js";
import type { CredentialDiagnosis, SecretStore } from "./types.js";

const service = "ai-ops-mcp";

interface KeyringEntry {
  setPassword(value: string): Promise<void>;
  getPassword(): Promise<string | undefined>;
  deleteCredential(): Promise<boolean>;
}

export type KeyringEntryFactory = (serviceName: string, reference: string) => KeyringEntry;

export class KeyringSecretStore implements SecretStore {
  constructor(
    private readonly createEntry: KeyringEntryFactory = (serviceName, reference) =>
      new AsyncEntry(serviceName, reference),
  ) {}

  async set(reference: string, value: string): Promise<void> {
    try {
      await this.createEntry(service, reference).setPassword(value);
    } catch (error) {
      throw this.unavailable("write", error);
    }
  }

  async get(reference: string): Promise<string | null> {
    try {
      return (await this.createEntry(service, reference).getPassword()) ?? null;
    } catch (error) {
      if (isMissingCredential(error)) return null;
      throw this.unavailable("read", error);
    }
  }

  async delete(reference: string): Promise<boolean> {
    try {
      return await this.createEntry(service, reference).deleteCredential();
    } catch (error) {
      if (isMissingCredential(error)) return false;
      throw this.unavailable("delete", error);
    }
  }

  async diagnose(): Promise<CredentialDiagnosis> {
    const reference = `diagnose/${process.pid}/${Date.now()}`;
    const value = `probe-${Date.now()}`;
    try {
      await this.set(reference, value);
      const loaded = await this.get(reference);
      if (loaded !== value) return { status: "error", message: "System credential store roundtrip failed." };
      return { status: "ok", message: "System credential store is available." };
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : "System credential store is unavailable." };
    } finally {
      await this.delete(reference).catch(() => undefined);
    }
  }

  private unavailable(operation: string, error: unknown): AppError {
    return new AppError(
      "CREDENTIAL_STORE_UNAVAILABLE",
      `System credential store ${operation} failed.`,
      { cause: error },
    );
  }
}

function isMissingCredential(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no entry|not found|could not be found|item not found|does not exist/i.test(message);
}
