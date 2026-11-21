// Rutas del diario y del proyecto: no pueden sacar una petición, ni un token, del origen loopback autorizado.
import { afterEach, describe, expect, test } from "vitest";
import { liveDoctor, validContext } from "../src/live/doctor.ts";
import { appUrl, get, loopbackUrl } from "../src/live/sandbox.ts";
import { routeRequest } from "../src/live/test.ts";

const TOKEN = "bgat_secreto_no_enviar";
const BASE = "http://127.0.0.1:3400";
const EVIL = [
  "//evil.example/x",
  "//evil.example",
  "/\\evil.example",
  "//user:pass@evil.example/x",
  "///evil.example/x",
  "/\\@evil.example",
  "/foo\\bar",
  "/%5Cevil.example",
  "/%5cevil.example",
  "\\\\evil.example",
  "http://evil.example/x",
  "http://user:pass@127.0.0.1:3400/x",
  "//127.0.0.1.evil.example/",
];

describe("rutas de prueba: no salen del loopback", () => {
  const calls: { url: string; auth: string; redirect: string }[] = [];
  const orig = globalThis.fetch;
  afterEach(() => { globalThis.fetch = orig; calls.length = 0; });
  const install = (status = 302) => {
    globalThis.fetch = (async (input: string | URL, init?: { headers?: Record<string, string>; redirect?: string }) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), auth: headers.get("authorization") ?? "", redirect: String(init?.redirect) });
      return new Response("no", { status, headers: { location: "http://evil.example/steal" } });
    }) as typeof fetch;
  };

  test("representaciones ambiguas: se rechazan y no hay petición", async () => {
    install();
    const base = loopbackUrl(`${BASE}/`);
    for (const path of EVIL) {
      expect(() => appUrl(base, path), path).toThrow();
      const hit = await routeRequest(base, path, TOKEN);
      expect(hit.status, path).toBeNull();
      expect(hit.body, path).toBe("");
    }
    expect(calls).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });

  test("una ruta del proyecto se queda en el origen autorizado", () => {
    expect(appUrl(loopbackUrl(`${BASE}/`), "/api/informes").href).toBe(`${BASE}/api/informes`);
  });

  test("get no envía la credencial si el destino no es exactamente ese origen", async () => {
    install();
    for (const url of ["http://evil.example/x", "http://user:pass@127.0.0.1:3400/x", "http://127.0.0.1:9/x", "http://127.0.0.1.evil.example/x"]) {
      const hit = await get(url, TOKEN, BASE);
      expect(hit.status, url).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  test("un 3xx no se sigue hacia otro origen", async () => {
    install();
    const hit = await get(`${BASE}/api/informes`, TOKEN, BASE);
    expect(hit.status).toBe(302);
    expect(calls).toEqual([{ url: `${BASE}/api/informes`, auth: `Bearer ${TOKEN}`, redirect: "manual" }]);
  });

  test("doctor rechaza la ruta del proyecto y no la pide", async () => {
    install(503);
    for (const exampleRoute of ["//evil.example/x", "/\\evil.example", "//user:pass@evil.example/x"]) {
      calls.length = 0;
      const ctx = validContext({ framework: "express", licensedPaths: ["/api"], exampleRoute, endpoint: BASE });
      const findings = await liveDoctor(ctx, { app: null, instance: "no-existe", baseUrl: BASE });
      expect(findings.some((f) => f.level === "fail" && f.message.includes("No se ha enviado ninguna petición")), exampleRoute).toBe(true);
      expect(calls.every((c) => c.url.startsWith(`${BASE}/`)), exampleRoute).toBe(true);
      expect(calls.some((c) => c.auth.includes(TOKEN)), exampleRoute).toBe(false);
      expect(calls.some((c) => /evil\.example/.test(c.url)), exampleRoute).toBe(false);
    }
  });
});
