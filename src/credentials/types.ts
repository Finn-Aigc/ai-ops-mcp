import type { ServerConfig } from "../config/schema.js";

export type ResolvedCredential =
  | { type: "agent"; agentSocket: string; publicKeyFingerprint?: string }
  | { type: "password"; password: string }
  | { type: "privateKey"; privateKey: Buffer; passphrase?: string };

export interface CredentialDiagnosis {
  status: "ok" | "warn" | "error";
  message: string;
}

export interface CredentialProvider {
  supports(server: ServerConfig): boolean;
  resolve(server: ServerConfig): Promise<ResolvedCredential>;
  diagnose(server: ServerConfig): Promise<CredentialDiagnosis>;
}

export interface SecretStore {
  set(reference: string, value: string): Promise<void>;
  get(reference: string): Promise<string | null>;
  delete(reference: string): Promise<boolean>;
  diagnose(): Promise<CredentialDiagnosis>;
}
