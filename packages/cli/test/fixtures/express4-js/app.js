const express = require("express");
const apiRouter = require("./routes/api");
const registerAdmin = require("./routes/admin");

const app = express();
app.use(express.json());
app.use("/assets", express.static("public"));

app.get("/health", (req, res) => res.json({ ok: true }));
app.post("/login", (req, res) => res.json({ token: "x" }));
app.post("/webhooks/stripe", (req, res) => res.sendStatus(200));
app.get("/", (req, res) => res.send("hola"));

app.use("/api", apiRouter);
registerAdmin(app);

app.listen(3000);
