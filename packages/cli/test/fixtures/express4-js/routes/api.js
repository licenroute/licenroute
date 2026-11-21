const express = require("express");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const v2 = express.Router();
const BASE = "/catalogo";

router.get("/reports", (req, res) => res.json([]));
router.get("/reports/:id", (req, res) => res.json({}));
router.get("/me", requireAuth, (req, res) => res.json({}));
router.route("/items").get((req, res) => res.json([])).post((req, res) => res.status(201).end());
router.get(BASE + "/:sku", (req, res) => res.json({}));
router.get(process.env.EXTRA_PATH, (req, res) => res.json({}));
["norte", "sur"].forEach((region) => router.get("/zonas/" + region, (req, res) => res.json({})));

v2.get("/stats", (req, res) => res.json({}));
router.use("/v2", v2);

module.exports = router;
