import { AuditLogger } from "./audit/logger.js";
import { ConfigRepository } from "./config/repository.js";
import { getAppPaths } from "./config/paths.js";
import {
  AgentCredentialProvider,
  CredentialResolver,
  PrivateKeyCredentialProvider,
  SystemCredentialProvider,
} from "./credentials/providers.js";
import { createSystemSecretStore } from "./credentials/secret-store.js";
import { OperationsService } from "./services/operations.js";
import { ConnectionPool } from "./ssh/connection-pool.js";

export async function createApplication() {
  const paths = getAppPaths();
  const repository = new ConfigRepository(paths.configFile);
  const config = await repository.load();
  const secretStore = createSystemSecretStore();
  const credentials = new CredentialResolver([
    new AgentCredentialProvider(),
    new SystemCredentialProvider(secretStore),
    new PrivateKeyCredentialProvider(secretStore),
  ]);
  const pool = new ConnectionPool(credentials);
  const audit = new AuditLogger(paths.auditFile, config.defaults.auditCommandMode);
  const operations = new OperationsService(repository, credentials, pool, audit);
  return { paths, repository, secretStore, credentials, pool, audit, operations };
}
