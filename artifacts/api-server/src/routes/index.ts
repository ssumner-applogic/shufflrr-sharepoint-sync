import { Router, type IRouter } from "express";
import authRouter from "./auth";
import healthRouter from "./health";
import sharepointRouter from "./sharepoint";

const router: IRouter = Router();

router.use(authRouter);
router.use(healthRouter);
router.use(sharepointRouter);

export default router;
