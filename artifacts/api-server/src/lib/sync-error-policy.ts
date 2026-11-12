import { AccessError } from "./sharepoint";
import { FileTransferError } from "./sync-transfer";
import { ShufflrrError } from "@workspace/shufflrr";

/** Continue only for known item-local failures. Unknown/database/network errors fail closed. */
export function canContinueAfterFileError(error: unknown): boolean {
  if (error instanceof FileTransferError && error.status === undefined) return true;
  const status = error instanceof ShufflrrError && error.code === "http" ? error.httpStatus
    : error instanceof FileTransferError || error instanceof AccessError ? error.status : undefined;
  // Authentication, permissions, throttling and provider outages are never item-local.
  return status !== undefined && [400, 404, 409, 412, 413, 415, 422, 423].includes(status);
}
