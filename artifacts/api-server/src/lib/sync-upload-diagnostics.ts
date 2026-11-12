/** Never expose provider messages: they can contain file paths, account details or capability URLs. */
const reasons: Record<string, { reason: string; status: number }> = {
  maxfilesizeexceeded: { reason: "SharePoint rejected the file because it exceeds the destination's file-size limit.", status: 413 },
  filesizelimitexceeded: { reason: "SharePoint rejected the file because it exceeds the destination's file-size limit.", status: 413 },
  filetoolarge: { reason: "SharePoint rejected the file because it exceeds the destination's file-size limit.", status: 413 },
  requestentitytoolarge: { reason: "SharePoint rejected the upload because the request is too large.", status: 413 },
  requestbodytoolarge: { reason: "SharePoint rejected the upload because the request is too large.", status: 413 },
  quotalimitreached: { reason: "SharePoint has insufficient storage quota. Free space or ask an administrator to increase the quota.", status: 507 },
  insufficientstorage: { reason: "SharePoint has insufficient storage quota. Free space or ask an administrator to increase the quota.", status: 507 },
  accessdenied: { reason: "SharePoint denied write access. Check the service account's destination permissions.", status: 403 },
  unauthenticated: { reason: "SharePoint rejected the authentication. Check the server's Microsoft credentials.", status: 401 },
  invalidauthenticationtoken: { reason: "SharePoint rejected the authentication token. Check the server's Microsoft credentials.", status: 401 },
  namealreadyexists: { reason: "An item with this name already exists in SharePoint. It was not overwritten.", status: 409 },
  resourcelocked: { reason: "The SharePoint file is locked or checked out. Release the lock and retry.", status: 423 },
  locked: { reason: "The SharePoint file is locked or checked out. Release the lock and retry.", status: 423 },
  uploadsessionexpired: { reason: "The SharePoint upload session expired. Retry to start a new upload session.", status: 404 },
  invalidrange: { reason: "SharePoint rejected the upload byte range. Retry to start a new upload session.", status: 400 },
  fragmentlengthmismatch: { reason: "SharePoint rejected an upload fragment because its byte count did not match the declared range.", status: 400 },
};

function knownReason(code: unknown) {
  if (typeof code !== "string") return undefined;
  const key = code.toLowerCase().replace(/[._-]/g, "");
  return Object.hasOwn(reasons, key) ? reasons[key] : undefined;
}

export function uploadRejection(status: number, body?: unknown): { message: string; status: number } {
  let detail = body;
  let known: ReturnType<typeof knownReason>;
  // Graph can put the specific code inside error.innerError or innererror.
  for (let depth = 0; depth < 6 && detail && typeof detail === "object"; depth++) {
    if ("code" in detail) known = knownReason(detail.code) ?? known;
    detail = "error" in detail ? detail.error
      : "innerError" in detail ? detail.innerError : "innererror" in detail ? detail.innererror : undefined;
  }
  const byStatus: Record<number, string> = {
    400: "SharePoint rejected the upload request. No more specific reason was provided.",
    401: "SharePoint rejected the authentication. Check the server's Microsoft credentials.",
    403: "SharePoint denied write access. Check the service account's destination permissions.",
    404: "The SharePoint destination or upload session was not found. Refresh the destination and retry.",
    409: "The upload conflicts with an existing or changed SharePoint item. Review the destination before retrying.",
    412: "The SharePoint item changed during the upload. Refresh the destination and retry.",
    413: "SharePoint rejected the upload as too large. The app allows up to 300 MB; the destination may enforce a lower limit.",
    423: "The SharePoint file is locked or checked out. Release the lock and retry.",
    429: "SharePoint throttled the upload. Retry after the provider cooldown.",
    500: "SharePoint reported an internal server error during upload. Retry later.",
    502: "A gateway reported an error while contacting SharePoint. Retry later.",
    503: "SharePoint is temporarily unavailable. Retry after the provider cooldown.",
    504: "A gateway timed out while contacting SharePoint. The upload result is unknown; retry later.",
    507: "SharePoint has insufficient storage quota. Free space or ask an administrator to increase the quota.",
  };
  // Never let an item-local code downgrade an authentication, throttling or server failure.
  const sharedFailure = status === 401 || status === 403 || status === 429 || status >= 500;
  const reason = sharedFailure ? byStatus[status] ?? known?.reason : known?.reason ?? byStatus[status];
  return {
    message: `${reason ?? "SharePoint rejected the upload without a recognized reason."} (HTTP ${status}).`,
    status: sharedFailure ? status : known?.status ?? status,
  };
}

/** Read only a small response, not arbitrary HTML/error pages or unbounded provider payloads. */
export async function readUploadResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 16_384) return undefined;
      chunks.push(chunk.value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(data)) as unknown;
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function fileSizeDescription(bytes: number): string {
  return `${(bytes / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })} MB (${bytes.toLocaleString("en-US")} bytes)`;
}
