import express from "express";
import { requireUser } from "./auth.js";

const app = express();
app.get("/health", (req, res) => res.json({ ok: true }));
app.post("/login", (req, res) => res.json({ token: "x" }));
app.post("/logout", (req, res) => res.sendStatus(204));
app.get("/me", requireUser, (req, res) => res.json({ id: 1 }));
app.get("/settings", requireUser, (req, res) => res.json({}));
app.listen(3000);
