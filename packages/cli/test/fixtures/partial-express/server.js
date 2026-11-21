const fs = require("fs");
const express = require("express");
const app = express();
for (const file of fs.readdirSync(__dirname + "/routes")) {
  app.use("/" + file.replace(".js", ""), require("./routes/" + file));
}
app.get("/estado", (req, res) => res.json({ ok: true }));
module.exports = app;
