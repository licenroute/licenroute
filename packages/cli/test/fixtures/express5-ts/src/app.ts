import express, { type Request, type Response } from "express";
import { usersRouter } from "./routes/users.js";
import catalog from "./routes/catalog.js";
import { authenticate } from "./middleware.js";

export const app = express();
app.use(express.json());

app.get("/up", (_req: Request, res: Response) => res.json({ ok: true }));
app.get("/docs", (_req: Request, res: Response) => res.render("docs"));
app.use("/v1/users", authenticate, usersRouter);
app.use("/v1/catalog", catalog);
app.get(`/v1/precios/:sku`, (_req: Request, res: Response) => res.json({}));
app.get("/*splat", (_req: Request, res: Response) => res.status(404).json({ error: "no encontrado" }));
