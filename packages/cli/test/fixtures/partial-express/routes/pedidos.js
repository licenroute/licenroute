const { Router } = require("express");
const r = Router();
r.get("/", (req, res) => res.json([]));
r.get("/:id", (req, res) => res.json({}));
module.exports = r;
