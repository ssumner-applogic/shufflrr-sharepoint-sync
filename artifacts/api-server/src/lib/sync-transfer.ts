import { fileSizeDescription, readUploadResponse, uploadRejection } from "./sync-upload-diagnostics";

/** Decimal MB, matching the limit shown to users. Transfer memory is bounded by a chunk, not file size. */
export const MAX_SYNC_FILE_BYTES = 300_000_000;
export const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024; // 16 × Graph's required 320 KiB multiple.
export class FileTransferError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
export interface SyncFileStream { body: ReadableStream<Uint8Array>; size: number }

export function sourceFileStream(response: Response, metadataSize?: number): SyncFileStream {
  const header = response.headers.get("content-length");
  const advertised = header === null ? undefined : Number(header);
  const size = metadataSize ?? advertised;
  if (!response.ok || !response.body) throw new FileTransferError("The Shufflrr file download failed.");
  if (size === undefined || !Number.isSafeInteger(size) || size < 0)
    throw new FileTransferError("The source file size is unavailable. Refresh Shufflrr and try again.");
  if (size > MAX_SYNC_FILE_BYTES || (advertised ?? 0) > MAX_SYNC_FILE_BYTES)
    throw new FileTransferError(`The source file is ${fileSizeDescription(Math.max(size, advertised ?? 0))}; the app's sync limit is 300 MB (300,000,000 bytes).`);
  if (advertised !== undefined && metadataSize !== undefined && advertised !== metadataSize)
    throw new FileTransferError("The source file size changed. Try again after the file has finished updating.");
  return { body: response.body, size };
}

/** Sequential upload; validate EOF before sending the final fragment, so truncated streams cannot commit. */
export async function uploadChunks(
  source: SyncFileStream,
  send: (chunk: Uint8Array, start: number, total: number) => Promise<Response>,
): Promise<{ id: string; name: string; size: number; cTag?: string }> {
  if (!Number.isSafeInteger(source.size) || source.size < 1)
    throw new FileTransferError("The source file has an invalid size. A positive whole-number byte count is required.");
  if (source.size > MAX_SYNC_FILE_BYTES)
    throw new FileTransferError(`The source file is ${fileSizeDescription(source.size)}; the app's sync limit is 300 MB (300,000,000 bytes).`);
  const reader = source.body.getReader();
  let pending: Uint8Array = new Uint8Array(0);
  let offset = 0;
  try {
    while (offset < source.size) {
      const chunk = new Uint8Array(Math.min(UPLOAD_CHUNK_BYTES, source.size - offset));
      let filled = 0;
      while (filled < chunk.length) {
        if (!pending.length) {
          const read = await reader.read();
          if (read.done) throw new FileTransferError("The source download ended early. The file was not committed; try again.");
          pending = read.value;
          if (!pending.length) continue;
        }
        const count = Math.min(pending.length, chunk.length - filled);
        chunk.set(pending.subarray(0, count), filled);
        pending = pending.subarray(count);
        filled += count;
      }
      const last = offset + filled === source.size;
      if (last) {
        if (pending.length || !(await reader.read()).done)
          throw new FileTransferError("The source file size changed. The file was not committed; try again.");
      }
      const response = await send(chunk, offset, source.size);
      const result = await readUploadResponse(response);
      if (!response.ok || (result && typeof result === "object" && "error" in result)) {
        const rejection = uploadRejection(response.status, result);
        throw new FileTransferError(rejection.message, rejection.status);
      }
      if (!result || typeof result !== "object") {
        throw new FileTransferError(`SharePoint returned an unreadable or unexpected upload response (HTTP ${response.status}). The root cause was not provided; upload success could not be verified.`);
      }
      if (last && (response.status === 200 || response.status === 201) &&
        typeof result === "object" && result !== null &&
        "id" in result && typeof result.id === "string" &&
        "name" in result && typeof result.name === "string" &&
        (!("cTag" in result) || typeof result.cTag === "string") &&
        "size" in result && result.size === source.size) {
        return result as { id: string; name: string; size: number; cTag?: string };
      }
      if (last && (response.status === 200 || response.status === 201)) {
        if ("size" in result && typeof result.size === "number" && Number.isSafeInteger(result.size) && result.size >= 0 &&
          result.size !== source.size)
          throw new FileTransferError(`SharePoint reported ${fileSizeDescription(result.size)}, but the source is ${fileSizeDescription(source.size)}. The uploaded file size does not match; sync was not marked successful.`);
        throw new FileTransferError(`SharePoint's completion response is missing valid file details (HTTP ${response.status}). The root cause was not provided; upload success could not be verified.`);
      }
      if (last && response.status === 202)
        throw new FileTransferError("SharePoint still reports the upload as incomplete after the final fragment (HTTP 202). The root cause was not provided; retry to start a new upload session.");
      if (response.status !== 202 ||
        !("nextExpectedRanges" in result) || !Array.isArray(result.nextExpectedRanges) ||
        result.nextExpectedRanges[0] !== `${offset + filled}-`) {
        throw new FileTransferError(`SharePoint did not acknowledge the expected next byte offset (${offset + filled}) after the upload fragment (HTTP ${response.status}). Retry to start a new upload session.`);
      }
      offset += filled;
    }
    throw new FileTransferError("SharePoint did not confirm the completed upload.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
