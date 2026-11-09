import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", router);

if (process.env.SERVE_FRONTEND === "true") {
  const publicDir = path.resolve(process.cwd(), "artifacts/sharepoint-browser/dist/public");
  const indexPath = path.join(publicDir, "index.html");

  if (!existsSync(indexPath)) {
    throw new Error("Built frontend assets are missing. Run pnpm run build before starting the production server.");
  }

  app.use(express.static(publicDir, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path === "/api" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(indexPath, error => {
      if (error) next(error);
    });
  });
}

export default app;
