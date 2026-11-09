import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import {
  ListShufflrrItemsQueryParams, ListShufflrrItemsResponse,
  DownloadShufflrrFileParams, TestShufflrrAccessBody, TestShufflrrAccessResponse,
} from "@workspace/api-zod";
import { ShufflrrError, validateBaseUrl } from "@workspace/shufflrr";
import { probeAccess } from "@workspace/shufflrr/probe";
import { newShufflrrClient, readShufflrr, shufflrrConfig, shufflrrItem } from "../lib/shufflrr";

const router: IRouter = Router();
function fail(req: Request, res: Response, error: unknown): void {
  const known = error instanceof ShufflrrError;
  req.log.warn({ event: "shufflrr_failure", code: known ? error.code : "unexpected" }, "Shufflrr request failed.");
  const status = known && error.code === "configuration" ? 503
    : known && error.code === "permission" ? 403 : 502;
  res.status(status).json({
    error: known ? error.message : "Shufflrr is temporarily unavailable.",
    requestId: String(req.id),
  });
}
router.use("/shufflrr", (req, res, next) => {
  const requestId = String(req.id ?? randomUUID());
  res.set("X-Request-ID", requestId);
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.removeHeader("Access-Control-Allow-Origin");
  const reject = (status: number, error: string) => res.status(status).json({ error, requestId });
  const origin = req.get("origin");
  try {
    if (req.get("sec-fetch-site") === "cross-site" ||
      (origin && new URL(origin).host !== req.get("host") && new URL(origin).host !== req.get("x-forwarded-host"))) {
      reject(403, "Cross-origin access is not allowed."); return;
    }
  } catch { reject(403, "Invalid request origin."); return; }
  const { isAuthenticated, userId } = getAuth(req);
  if (!isAuthenticated || !userId) { reject(401, "Sign in to access Shufflrr."); return; }
  // Existing product policy: Clerk-managed app accounts access the single configured service-account portal.
  next();
});
router.get("/shufflrr/items", async (req, res): Promise<void> => {
  const query = ListShufflrrItemsQueryParams.safeParse(req.query);
  if (!query.success || (req.query.folderId !== undefined && typeof req.query.folderId !== "string")) {
    res.status(400).json({ error: "Invalid folder parameters.", requestId: String(req.id) }); return;
  }
  try {
    const items = await readShufflrr(client => query.data.folderId === undefined
      ? client.roots() : client.contents(query.data.folderId));
    const portalUrl = new URL(validateBaseUrl(shufflrrConfig().baseUrl)).origin;
    res.json(ListShufflrrItemsResponse.parse({
      portalUrl, items: items.map(shufflrrItem).sort((a, b) =>
        Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name, undefined, { numeric: true })),
    }));
  } catch (error) { fail(req, res, error); }
});
router.get("/shufflrr/files/:id/download", async (req, res): Promise<void> => {
  const params = DownloadShufflrrFileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid file parameters.", requestId: String(req.id) }); return;
  }
  let upstream: globalThis.Response | undefined;
  try {
    const { entry, response } = await readShufflrr(async client => {
      const entry = await client.file(params.data.id);
      if (entry.isFolder) throw new ShufflrrError("schema", "Choose a file to download.");
      return { entry, response: await client.download(params.data.id) };
    });
    upstream = response;
    if (!response.body) throw new ShufflrrError("http", "The file download returned no content.");
    // Bound transfers, including chunked responses; never persist files to disk.
    const maxBytes = 100 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > maxBytes)
      throw new ShufflrrError("limit", "This file exceeds the 100 MiB download limit.");
    res.set("Content-Type", "application/octet-stream");
    const filename = entry.name.replace(/[\u0000-\u001f\u007f]/g, "_");
    res.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`);
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new Error("Download limit reached") : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), limiter, res);
  } catch (error) {
    if (res.headersSent || res.destroyed) {
      req.log.warn({ event: "shufflrr_download_interrupted" }, "Download transfer did not complete.");
      res.destroy();
    } else {
      await upstream?.body?.cancel().catch(() => {});
      fail(req, res, error);
    }
  }
});
router.post("/shufflrr/test", async (req, res): Promise<void> => {
  const body = TestShufflrrAccessBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Select a root folder and confirm temporary test changes.", requestId: String(req.id) }); return;
  }
  let client: ReturnType<typeof newShufflrrClient> | undefined;
  try {
    client = newShufflrrClient();
    const config = shufflrrConfig();
    await client.login(config.email, config.password);
    const report = await probeAccess(client, body.data.rootFolderId);
    req.log.info({ event: "shufflrr_probe_complete", ok: report.ok, cleanupOk: report.cleanupOk }, "Scoped Shufflrr access probe finished.");
    res.json(TestShufflrrAccessResponse.parse(report));
  } catch (error) { fail(req, res, error); }
  finally { await client?.close(); }
});
export default router;
