import express from "express";
import { licenroute } from "@licenroute/connect-express";

const app = express();
app.get("/temprana", (req, res) => res.json({ antes: true }));
app.use(licenroute({ apiKey: process.env.LICENROUTE_API_KEY, siteId: process.env.LICENROUTE_SITE_ID, endpoint: process.env.LICENROUTE_ENDPOINT, licensedPaths: ["/api/informes/**"] }));
app.get("/api/informes/:id", (req, res) => res.json({}));
app.get("/api/estadisticas", (req, res) => res.json({}));
app.listen(3000);
