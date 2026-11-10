/** Decimal MB, matching the limit shown to users. Transfer memory is bounded by a chunk, not file size. */
export const MAX_SYNC_FILE_BYTES = 300_000_000;
export const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024; // 16 × Graph's required 320 KiB multiple.
export class FileTransferError extends Error {}
export interface SyncFileStream { body: ReadableStream<Uint8Array>; size: number }

export function sourceFileStream(response: Response, metadataSize?: number): SyncFileStream {
  const header = response.headers.get("content-length");
  const advertised = header === null ? undefined : Number(header);
  const size = metadataSize ?? advertised;
  if (!response.ok || !response.body) throw new FileTransferError("The Shufflrr file download failed.");
  if (size === undefined || !Number.isSafeInteger(size) || size < 0)
    throw new FileTransferError("The source file size is unavailable. Refresh Shufflrr and try again.");
  if (size > MAX_SYNC_FILE_BYTES || (advertised ?? 0) > MAX_SYNC_FILE_BYTES)
    throw new FileTransferError("This file exceeds the 300 MB sync limit.");
  if (advertised !== undefined && metadataSize !== undefined && advertised !== metadataSize)
    throw new FileTransferError("The source file size changed. Try again after the file has finished updating.");
  return { body: response.body, size };
}

/** Sequential upload; validate EOF before sending the final fragment, so truncated streams cannot commit. */
export async function uploadChunks(
  source: SyncFileStream,
  send: (chunk: Uint8Array, start: number, total: number) => Promise<Response>,
): Promise<{ id: string; name: string; size: number; cTag?: string }> {
  if (!Number.isSafeInteger(source.size) || source.size < 1 || source.size > MAX_SYNC_FILE_BYTES)
    throw new FileTransferError("This file exceeds the 300 MB sync limit or has an invalid size.");
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
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new FileTransferError(`SharePoint rejected an upload fragment (HTTP ${response.status}). Try again or check write access.`);
      }
      const result: unknown = await response.json();
      if (last && (response.status === 200 || response.status === 201) &&
        typeof result === "object" && result !== null &&
        "id" in result && typeof result.id === "string" &&
        "name" in result && typeof result.name === "string" &&
        (!("cTag" in result) || typeof result.cTag === "string") &&
        "size" in result && result.size === source.size) {
        return result as { id: string; name: string; size: number; cTag?: string };
      }
      if (last || response.status !== 202 || typeof result !== "object" || result === null ||
        !("nextExpectedRanges" in result) || !Array.isArray(result.nextExpectedRanges) ||
        result.nextExpectedRanges[0] !== `${offset + filled}-`) {
        throw new FileTransferError("SharePoint did not confirm the upload. No sync success was recorded; try again.");
      }
      offset += filled;
    }
    throw new FileTransferError("SharePoint did not confirm the completed upload.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
