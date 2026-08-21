import { chmod } from "node:fs/promises";
import { AppError } from "../errors/app-error.js";
import { runProcess } from "../credentials/process.js";

export async function applyPrivateFilePermissions(filePath: string): Promise<void> {
  await chmod(filePath, 0o600);
  if (process.platform !== "win32") return;
  const username = process.env.USERNAME;
  if (!username) {
    throw new AppError("CONFIG_INVALID", "Unable to determine the current Windows user for config ACL.");
  }
  const result = await runProcess("icacls.exe", [
    filePath,
    "/inheritance:r",
    "/grant:r",
    `${username}:(F)`,
  ]);
  if (result.exitCode !== 0) {
    throw new AppError("CONFIG_INVALID", "Unable to apply a private Windows ACL to the config file.", {
      cause: new Error(result.stderr.trim() || result.stdout.trim()),
    });
  }
}
