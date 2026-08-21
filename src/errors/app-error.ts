export type ErrorCode =
  | "SERVER_NOT_FOUND"
  | "CONFIG_INVALID"
  | "CREDENTIAL_NOT_FOUND"
  | "CREDENTIAL_STORE_UNAVAILABLE"
  | "CREDENTIAL_ACCESS_DENIED"
  | "AGENT_UNAVAILABLE"
  | "AGENT_IDENTITY_NOT_FOUND"
  | "HOST_KEY_UNTRUSTED"
  | "HOST_KEY_MISMATCH"
  | "SSH_CONNECTION_TIMEOUT"
  | "SSH_AUTHENTICATION_FAILED"
  | "COMMAND_TIMEOUT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "FILE_SIZE_LIMIT_EXCEEDED"
  | "LOCAL_PATH_NOT_ALLOWED"
  | "REMOTE_PATH_NOT_ALLOWED"
  | "LOCAL_FILE_EXISTS"
  | "SFTP_TIMEOUT"
  | "CONCURRENCY_LIMIT"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly retriable: boolean;
  public readonly action: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retriable?: boolean; action?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.retriable = options.retriable ?? false;
    this.action = options.action;
  }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : "Unknown error";
  return new AppError("INTERNAL_ERROR", message, { cause: error });
}
