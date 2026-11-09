import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/auth/config", (_req, res) => {
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    res.status(503).json({ error: "Authentication is not configured." });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.json({ publishableKey });
});

export default router;
