const express = require("express");

const app = express();
// The app's own authentication: a user token checked by the app, unrelated to LicenRoute.
const requireUser = (req, res, next) => (req.get("authorization") === "Bearer user-token-123" ? next() : res.status(401).json({ error: "login required" }));

app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/coupons", (req, res) => res.json([{ code: "SPRING" }]));
app.get("/coupons/:code", (req, res) => res.json({ code: req.params.code }));
app.post("/coupons/redeem", requireUser, (req, res) => res.status(201).json({ redeemed: true }));

const port = Number(process.env.PORT ?? 3500);
app.listen(port, "127.0.0.1", () => console.log(`coupons-api on http://127.0.0.1:${port}`));
