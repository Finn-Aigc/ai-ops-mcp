import { z } from "zod";

const agentAuthSchema = z.object({
  type: z.literal("agent"),
  publicKeyFingerprint: z.string().min(1).optional(),
});

const systemCredentialAuthSchema = z.object({
  type: z.literal("systemCredential"),
  credentialRef: z.string().min(1),
});

const privateKeyAuthSchema = z.object({
  type: z.literal("privateKey"),
  privateKeyPath: z.string().min(1),
  passphraseRef: z.string().min(1).optional(),
});

export const authConfigSchema = z.discriminatedUnion("type", [
  agentAuthSchema,
  systemCredentialAuthSchema,
  privateKeyAuthSchema,
]);

export const serverConfigSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  name: z.string().min(1),
  group: z.string().min(1).optional(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  auth: authConfigSchema,
  hostKey: z.object({
    algorithm: z.string().min(1),
    fingerprint: z.string().startsWith("SHA256:"),
  }),
  allowedLocalPaths: z.array(z.string().min(1)).optional(),
  allowedRemotePaths: z.array(z.string().min(1)).optional(),
  limits: z
    .object({
      commandTimeoutMs: z.number().int().positive().optional(),
      sftpTimeoutMs: z.number().int().positive().optional(),
      maxOutputBytes: z.number().int().nonnegative().optional(),
      maxFileBytes: z.number().int().positive().optional(),
      maxChannels: z.number().int().positive().optional(),
    })
    .optional(),
});

export const appConfigSchema = z.object({
  version: z.literal(1),
  defaults: z
    .object({
      commandTimeoutMs: z.number().int().positive().default(30_000),
      sftpTimeoutMs: z.number().int().positive().default(300_000),
      maxOutputBytes: z.number().int().nonnegative().default(10 * 1024 * 1024),
      maxChannelsPerServer: z.number().int().positive().default(4),
      maxGlobalChannels: z.number().int().positive().default(16),
      maxFileBytes: z.number().int().positive().default(100 * 1024 * 1024),
      exposeConnectionMetadata: z.boolean().default(false),
      auditCommandMode: z.enum(["full", "hash"]).default("full"),
    })
    .default({
      commandTimeoutMs: 30_000,
      sftpTimeoutMs: 300_000,
      maxOutputBytes: 10 * 1024 * 1024,
      maxChannelsPerServer: 4,
      maxGlobalChannels: 16,
      maxFileBytes: 100 * 1024 * 1024,
      exposeConnectionMetadata: false,
      auditCommandMode: "full",
    }),
  servers: z.array(serverConfigSchema).default([]),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

const forbiddenSecretKeys = new Set([
  "password",
  "passphrase",
  "privatekeycontent",
  "private_key_content",
  "secret",
  "token",
]);

export function assertNoSecretFields(value: unknown, path = "config"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenSecretKeys.has(key.toLowerCase())) {
      throw new Error(`Secret field '${path}.${key}' is not allowed in config`);
    }
    assertNoSecretFields(child, `${path}.${key}`);
  }
}
