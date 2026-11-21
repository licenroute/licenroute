import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../../../packages/policy-contracts/fixtures/${name}`, import.meta.url), "utf8")) as T;

export const API_KEY = `bg_test_abcdefgh_${"A".repeat(43)}`;
export const SITE_ID = "site_testsite0001";

export interface ApiReply {
  status?: number;
  body?: unknown;
  raw?: string;
  content_type?: string;
  headers?: Record<string, string>;
  delay_ms?: number;
}

/** API falsa (servidor HTTP real). Registra las peticiones recibidas para comprobar privacidad. */
export class FakeApi {
  readonly received: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  reply: ApiReply | ((url: string) => ApiReply) = { status: 200, body: allow() };
  private server!: Server;
  port = 0;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        this.received.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        const r = typeof this.reply === "function" ? this.reply(req.url!) : this.reply;
        const respond = () => {
          res.statusCode = r.status ?? 200;
          for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
          res.setHeader("content-type", r.content_type ?? "application/json");
          const isDecision = req.url === "/v1/decisions" && r.body && typeof r.body === "object";
          res.end(r.raw ?? JSON.stringify(isDecision ? { request_id: "x", ...(r.body as object) } : r.body));
        };
        if (r.delay_ms) setTimeout(respond, r.delay_ms);
        else respond();
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  decisionRequests() {
    return this.received.filter((r) => r.url === "/v1/decisions");
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
}

export const allow = (extra: Record<string, unknown> = {}) => ({ action: "allow", risk_score: 0, reason_codes: [], policy_version: 1, ttl_seconds: 0, ...extra });

const require = createRequire(import.meta.url);
type ExpressApp = { use: (...a: unknown[]) => void; get: (...a: unknown[]) => void; post: (...a: unknown[]) => void; listen: (...a: unknown[]) => Server };

/** App Express real (4 o 5) con el middleware delante y rutas de prueba. */
export async function startApp(version: 4 | 5, middleware: unknown): Promise<{ port: number; close: () => Promise<void> }> {
  const express = require(version === 5 ? "express5" : "express4") as () => ExpressApp;
  const app = express();
  app.use(middleware);
  const ok = (req: { licenroute?: unknown; path: string }, res: { json: (b: unknown) => void }) => res.json({ ok: true, path: req.path, licenroute: req.licenroute ?? null });
  app.get("/health/live", ok);
  app.get("/", ok);
  app.get("/admin", ok);
  app.post("/login", ok);
  app.get(version === 5 ? "/*splat" : "*", ok);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Petición HTTP cruda por socket (sin normalización del cliente). */
export function raw(port: number, method: string, target: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const lines = [`${method} ${target} HTTP/1.1`, "Host: localhost", "Connection: close", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      socket.write(lines.join("\r\n") + "\r\n\r\n", "latin1");
    });
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (c) => (data += c));
    socket.on("end", () => {
      const [head = "", ...rest] = data.split("\r\n\r\n");
      const [statusLine = "", ...headerLines] = head.split("\r\n");
      const hdrs: Record<string, string> = {};
      for (const l of headerLines) {
        const i = l.indexOf(":");
        hdrs[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
      }
      let body = rest.join("\r\n\r\n");
      if (hdrs["transfer-encoding"] === "chunked") body = body.replace(/^[0-9a-f]+\r\n/i, "").replace(/\r\n0\r\n\r\n$/, "").replace(/\r\n0\r\n$/, "");
      resolve({ status: Number(statusLine.split(" ")[1]), headers: hdrs, body });
    });
    socket.on("error", reject);
    socket.setTimeout(5000, () => socket.destroy(new Error("timeout")));
  });
}

export const silentLogger = { warn: () => {}, error: () => {} };
export const freePort = async (): Promise<number> => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
};
