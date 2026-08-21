import type { AppError } from "./app-error.js";

export function toPublicError(error: AppError): {
  code: string;
  message: string;
  retriable: boolean;
  action?: string;
} {
  return {
    code: error.code,
    message: error.message,
    retriable: error.retriable,
    ...(error.action ? { action: error.action } : {}),
  };
}
