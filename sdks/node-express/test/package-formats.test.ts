import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 0.8.1: the SDK installs and loads with require() (CommonJS) and with import (ESM), with no runtime dependencies,
// from the same tarball `npm pack` produces (what npm publishes). No network: the package has no dependencies.
const root = new URL("..", import.meta.url).pathname;
let work: string, tarball: string;

const npm = (args: string[], cwd: string) => execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const node = (args: string[], cwd: string) => execFileSync(process.execPath, args, { cwd, encoding: "utf8" }).trim();

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "lr-sdk-formats-"));
  execFileSync(process.execPath, [join(root, "scripts/build.mjs")], { cwd: root, stdio: "ignore" });
  npm(["pack", "--pack-destination", work, "--silent"], root);
  tarball = join(work, readdirSync(work).find((f) => f.endsWith(".tgz"))!);
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

const app = (type: "commonjs" | "module", file: string, code: string) => {
  const dir = mkdtempSync(join(work, `${type}-`));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `app-${type}`, version: "1.0.0", type, private: true }));
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", tarball], dir);
  writeFileSync(join(dir, file), code);
  return dir;
};
const OPTIONS = `{ apiKey: "bg_test_abcdefgh_" + "A".repeat(43), siteId: "site_test", endpoint: "https://decide.example", licensedPaths: [{ path: "/v1/**", methods: ["GET"] }], withoutPolicy: "deny", fallback: "allow" }`;

describe("package formats", () => {
  it("the published package declares no runtime dependencies", () => {
    const pkg = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.exports["."].require.default).toBe("./dist/cjs/index.js");
    expect(pkg.exports["."].import.default).toBe("./dist/index.js");
  });

  it("require() in a CommonJS app returns a working middleware factory", () => {
    const dir = app("commonjs", "app.js", `const { licenroute } = require("@licenroute/connect-express");
const mw = licenroute(${OPTIONS});
console.log(typeof licenroute, typeof mw, mw.length);`);
    expect(node(["app.js"], dir)).toBe("function function 3");
  }, 120_000);

  it("import in an ESM app returns the same API", () => {
    const dir = app("module", "app.mjs", `import { licenroute } from "@licenroute/connect-express";
const mw = licenroute(${OPTIONS});
console.log(typeof licenroute, typeof mw, mw.length);`);
    expect(node(["app.mjs"], dir)).toBe("function function 3");
  }, 120_000);

  it("both builds export the same names", () => {
    const dir = app("commonjs", "names.js", `const cjs = Object.keys(require("@licenroute/connect-express")).sort();
import("@licenroute/connect-express").then((esm) => console.log(JSON.stringify([cjs, Object.keys(esm).filter((k) => k !== "default").sort()])));`);
    const [cjs, esm] = JSON.parse(node(["names.js"], dir));
    expect(cjs).toEqual(esm);
    expect(cjs).toContain("licenroute");
  }, 120_000);
});
