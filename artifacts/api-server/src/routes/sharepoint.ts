import { Router, type IRouter } from "express";
import { GetConnectionStatusResponse, TestConnectionResponse, ListItemsQueryParams, ListItemsResponse } from "@workspace/api-zod";
import { libraryUrl, missingCredentials, productionBlocked, testAccess, listFolder, normalizeError, advice } from "../lib/sharepoint";

const router: IRouter = Router();
router.use("/sharepoint", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");
  // No cross-origin embedding or scripts may read this private prototype.
  res.removeHeader("Access-Control-Allow-Origin");
  const origin = req.get("origin");
  if (req.get("sec-fetch-site") === "cross-site" || (origin && new URL(origin).host !== req.get("host") && new URL(origin).host !== req.get("x-forwarded-host"))) {
    res.status(403).json({ error: "Cross-origin access is not allowed." }); return;
  }
  next();
});
router.get("/sharepoint/status", (_req, res) => {
  const missing = missingCredentials();
  res.json(GetConnectionStatusResponse.parse({
    configured: !missing.length, missing, libraryUrl, siteName: "ApplogicKnowledgeBase",
    libraryName: "Shared Documents", productionBlocked: productionBlocked(),
  }));
});
router.post("/sharepoint/test", async (_req, res): Promise<void> => {
  res.json(TestConnectionResponse.parse(await testAccess()));
});
router.get("/sharepoint/items", async (req, res): Promise<void> => {
  if (productionBlocked()) { res.status(503).json({ error: "SharePoint access is disabled outside development until app-level authentication is added." }); return; }
  const query = ListItemsQueryParams.safeParse(req.query);
  if (!query.success || (query.data.folderId?.length || 0) > 500 || (query.data.cursor?.length || 0) > 20000) {
    res.status(400).json({ error: "Invalid folder or pagination parameters." }); return;
  }
  try {
    res.json(ListItemsResponse.parse(await listFolder(query.data.folderId, query.data.cursor)));
  } catch (err) {
    const e = normalizeError(err);
    res.status(e.status === 400 ? 400 : 502).json({ error: e.message, code: e.code, advice: advice(e) });
  }
});
export default router;
