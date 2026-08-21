import path from "node:path";
import os from "node:os";

export interface AppPaths {
  configDir: string;
  configFile: string;
  dataDir: string;
  auditFile: string;
}

export function getAppPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const home = os.homedir();
  let configDir: string;
  let dataDir: string;

  if (env.AI_OPS_HOME) {
    configDir = env.AI_OPS_HOME;
    dataDir = env.AI_OPS_HOME;
  } else if (process.platform === "win32") {
    const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    configDir = path.join(appData, "ai-ops");
    dataDir = path.join(localAppData, "ai-ops");
  } else if (process.platform === "darwin") {
    configDir = path.join(home, "Library", "Application Support", "ai-ops");
    dataDir = path.join(home, "Library", "Logs", "ai-ops");
  } else {
    configDir = path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "ai-ops");
    dataDir = path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "ai-ops");
  }

  return {
    configDir,
    configFile: path.join(configDir, "config.json"),
    dataDir,
    auditFile: path.join(dataDir, "audit.jsonl"),
  };
}
