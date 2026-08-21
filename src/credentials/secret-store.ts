import type { SecretStore } from "./types.js";
import { KeyringSecretStore } from "./keyring-secret-store.js";

export function createSystemSecretStore(_platform = process.platform): SecretStore {
  return new KeyringSecretStore();
}
