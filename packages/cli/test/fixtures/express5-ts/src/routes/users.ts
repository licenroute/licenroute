import { Router } from "express";
export const usersRouter = Router();
usersRouter.get("/", (_req, res) => res.json([]));
usersRouter.get("/:id", (_req, res) => res.json({}));
usersRouter.delete("/:id", (_req, res) => res.status(204).end());
