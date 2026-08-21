import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { AppError } from "../errors/app-error.js";

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalExisting(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch {
    return null;
  }
}

export async function validateLocalPath(
  input: string,
  allowedRoots: string[],
  purpose: "read" | "write",
): Promise<string> {
  if (!input || input.includes("\0")) {
    throw new AppError("LOCAL_PATH_NOT_ALLOWED", "Local path is empty or contains a null byte.");
  }
  const resolved = path.resolve(input);
  const roots = await Promise.all(allowedRoots.map(async (root) => (await canonicalExisting(path.resolve(root))) ?? path.resolve(root)));
  const existing = await canonicalExisting(resolved);
  const parent = await canonicalExisting(path.dirname(resolved));
  if (purpose === "read" && !existing) {
    throw new AppError("LOCAL_PATH_NOT_ALLOWED", `Local file does not exist: ${resolved}`);
  }
  if (purpose === "write" && !parent) {
    throw new AppError("LOCAL_PATH_NOT_ALLOWED", `Local parent directory does not exist: ${path.dirname(resolved)}`);
  }
  const candidate = existing ?? (parent ? path.join(parent, path.basename(resolved)) : resolved);
  if (!roots.some((root) => isWithin(candidate, root))) {
    throw new AppError("LOCAL_PATH_NOT_ALLOWED", `Local path is outside the allowed roots: ${resolved}`);
  }
  if (purpose === "read") {
    const info = await stat(candidate);
    if (!info.isFile()) throw new AppError("LOCAL_PATH_NOT_ALLOWED", `Local path is not a file: ${resolved}`);
  }
  return resolved;
}

export function validateRemotePath(input: string, allowedRoots: string[]): string {
  if (!input || input.includes("\0") || !path.posix.isAbsolute(input)) {
    throw new AppError("REMOTE_PATH_NOT_ALLOWED", "Remote path must be a non-empty absolute POSIX path.");
  }
  const resolved = path.posix.normalize(input);
  if (allowedRoots.length === 0) return resolved;
  const allowed = allowedRoots.some((root) => {
    const normalizedRoot = path.posix.normalize(root);
    return resolved === normalizedRoot || resolved.startsWith(normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`);
  });
  if (!allowed) throw new AppError("REMOTE_PATH_NOT_ALLOWED", `Remote path is outside the allowed roots: ${resolved}`);
  return resolved;
}
