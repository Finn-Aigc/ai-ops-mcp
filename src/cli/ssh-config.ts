import { runProcess } from "../credentials/process.js";
import { AppError } from "../errors/app-error.js";

export interface ResolvedSshHost {
  host: string;
  port: number;
  username: string;
  identityFile?: string;
}

export async function resolveSshHost(alias: string, configFile?: string): Promise<ResolvedSshHost> {
  const result = await runProcess("ssh", [...(configFile ? ["-F", configFile] : []), "-G", alias]);
  if (result.exitCode !== 0) {
    throw new AppError("CONFIG_INVALID", `Unable to resolve SSH host alias '${alias}'.`);
  }
  const values = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const index = line.indexOf(" ");
    if (index <= 0) continue;
    const key = line.slice(0, index).toLowerCase();
    if (!values.has(key)) values.set(key, line.slice(index + 1).trim());
  }
  const host = values.get("hostname");
  const username = values.get("user");
  if (!host || !username) throw new AppError("CONFIG_INVALID", `SSH alias '${alias}' has no hostname or user.`);
  const identityFile = values.get("identityfile");
  return {
    host,
    port: Number.parseInt(values.get("port") ?? "22", 10),
    username,
    ...(identityFile && identityFile !== "none" ? { identityFile } : {}),
  };
}
