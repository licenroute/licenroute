const express = require("express");
const orphan = express.Router();
orphan.get("/secreto/:id", (req, res) => res.json({}));
module.exports = orphan;
