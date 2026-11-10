import { Router, type IRouter, type RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import {
  CreateSharePointFolderBody,
  CreateSharePointFolderResponse,
  DeleteSharePointItemParams,
  GetConnectionStatusResponse,
  ListItemsQueryParams,
  ListItemsResponse,
  TestConnectionResponse,
  UpdateSharePointItemBody,
  UpdateSharePointItemParams,
  UpdateSharePointItemResponse,
} from "@workspace/api-zod";
import {
  advice,
  createSharePointFolder,
  deleteSharePointItem,
  libraryUrl,
  listFolder,
  missingCredentials,
  normalizeError,
  testAccess,
  updateSharePointItem,
} from "../lib/sharepoint";

const router: IRouter = Router();
const requireSignedIn: RequestHandler = (req, res, next) => {
  const { isAuthenticated, userId } = getAuth(req);
  if (!isAuthenticated || !userId) {
    res.status(401).json({ error: "Sign in to access SharePoint." });
    return;
  }
  next();
};

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
router.use("/sharepoint", requireSignedIn);

router.get("/sharepoint/status", (_req, res) => {
  const missing = missingCredentials();
  res.json(GetConnectionStatusResponse.parse({
    configured: !missing.length, missing, libraryUrl, siteName: "ApplogicKnowledgeBase",
    libraryName: "Shared Documents", productionBlocked: false,
  }));
});
router.post("/sharepoint/test", async (_req, res): Promise<void> => {
  res.json(TestConnectionResponse.parse(await testAccess()));
});

function operationError(res: Parameters<RequestHandler>[1], err: unknown): void {
  const e = normalizeError(err);
  const status = [400, 401, 403, 404, 409].includes(e.status) ? e.status : 502;
  res.status(status).json({ error: e.message, code: e.code, advice: advice(e) });
}

router.post("/sharepoint/folders", async (req, res): Promise<void> => {
  const parsed = CreateSharePointFolderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid folder name or destination." });
    return;
  }
  try {
    const item = await createSharePointFolder(parsed.data.name, parsed.data.parentId);
    res.status(201).json(CreateSharePointFolderResponse.parse(item));
  } catch (err) {
    operationError(res, err);
  }
});

router.patch("/sharepoint/items/:itemId", async (req, res): Promise<void> => {
  const params = UpdateSharePointItemParams.safeParse(req.params);
  const body = UpdateSharePointItemBody.safeParse(req.body);
  if (!params.success || !body.success || (!body.data.name && body.data.parentId === undefined)) {
    res.status(400).json({ error: "Provide a valid item name or destination folder." });
    return;
  }
  try {
    const item = await updateSharePointItem(params.data.itemId, body.data);
    res.json(UpdateSharePointItemResponse.parse(item));
  } catch (err) {
    operationError(res, err);
  }
});

router.delete("/sharepoint/items/:itemId", async (req, res): Promise<void> => {
  const params = DeleteSharePointItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid SharePoint item." });
    return;
  }
  try {
    await deleteSharePointItem(params.data.itemId);
    res.sendStatus(204);
  } catch (err) {
    operationError(res, err);
  }
});

router.get("/sharepoint/items", async (req, res): Promise<void> => {
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
