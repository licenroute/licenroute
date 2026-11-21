import express from "express";

const app = express();

app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.json({ tienda: "demo" }));
app.post("/login", (req, res) => res.json({ ok: true }));
app.get("/api/informes", (req, res) => res.json([{ id: 1 }]));
app.get("/api/informes/:id", (req, res) => res.json({ informe: req.params.id }));
app.get("/api/catalogo", (req, res) => res.json([{ sku: "A1" }]));
app.post("/api/pedidos", (req, res) => res.status(201).json({ pedido: "nuevo" }));

const port = Number(process.env.PORT ?? 3400);
app.listen(port, "127.0.0.1", () => console.log(`demo-express en http://127.0.0.1:${port}`));
