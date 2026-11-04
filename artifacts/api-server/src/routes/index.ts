import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sharepointRouter from "./sharepoint";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sharepointRouter);

export default router;
