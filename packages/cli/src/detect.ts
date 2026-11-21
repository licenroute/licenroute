/**
 * `licenroute detect`: identifica Express y/o Rails en un directorio y lista sus rutas, sin ejecutar nada ni escribir.
 */
import { analyzeExpress } from "./express.ts";
import { analyzeRails, railsVersion } from "./rails.ts";
import { ProjectReader, type ReaderOptions } from "./reader.ts";
import type { DetectResult, Framework } from "./schema.ts";
import { sanitize } from "./util.ts";
import { tc } from "../bin/i18n.mjs";

export const TOOL_VERSION = "0.3.1";
const TOOL = { name: "@licenroute/cli" as const, version: TOOL_VERSION };

const major = (v: string | null): number | null => {
  const m = v ? /(\d+)/.exec(v) : null;
  return m ? Number(m[1]) : null;
};

function readJson(reader: ProjectReader, file: string): Record<string, unknown> | null {
  const text = reader.read(file);
  if (text === null) return null;
  try { const v: unknown = JSON.parse(text); return v && typeof v === "object" ? (v as Record<string, unknown>) : null; } catch { return null; }
}

function expressVersion(reader: ProjectReader, pkg: Record<string, unknown> | null): string | null {
  const lock = readJson(reader, "package-lock.json");
  const packages = lock?.packages as Record<string, { version?: string }> | undefined;
  const locked = packages?.["node_modules/express"]?.version;
  if (typeof locked === "string") return locked;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg?.[field] as Record<string, unknown> | undefined;
    if (typeof deps?.express === "string") return deps.express;
  }
  return null;
}

const hasDep = (pkg: Record<string, unknown> | null, name: string) =>
  ["dependencies", "devDependencies"].some((f) => typeof (pkg?.[f] as Record<string, unknown> | undefined)?.[name] === "string");

export function detect(root: string, options: ReaderOptions = {}): DetectResult {
  const reader = new ProjectReader(root, options);
  const frameworks: Framework[] = [];
  const routes: DetectResult["routes"] = [];
  const unresolved: DetectResult["unresolved"] = [];
  const unparseable: { file: string; error: string }[] = [];
  const notes: string[] = [];
  const licenroute: DetectResult["licenroute"] = { present: false, sdk: null, locations: [], licensed_paths: null };

  const pkg = readJson(reader, "package.json");
  reader.read(".gitignore"); // su hash entra en el plan: apply puede tener que añadirle .env.licenroute y .licenroute/
  const gemfile = reader.read("Gemfile");

  // --- Express ---------------------------------------------------------------------------------------------------
  const expressDeclared = hasDep(pkg, "express");
  if (expressDeclared || reader.exists("package.json")) {
    const r = analyzeExpress(reader);
    if (expressDeclared || r.entryFiles.length > 0) {
      const version = expressVersion(reader, pkg);
      const mj = major(version);
      frameworks.push({ name: "express", version: version ? sanitize(version, 40) : null, major: mj, supported: mj === 4 || mj === 5, language: r.usesTypeScript ? "typescript" : "javascript", entry_files: r.entryFiles });
      if (mj !== null && mj !== 4 && mj !== 5) notes.push(tc("detect.express_unsupported", { mj }));
      if (mj === null) notes.push(tc("detect.express_version_unknown"));
      if (r.entryFiles.length === 0) notes.push(tc("detect.express_app_not_found"));
      routes.push(...r.routes); unresolved.push(...r.unresolved); unparseable.push(...r.unparseable);
      if (r.licenroute.locations.length > 0 || hasDep(pkg, "@licenroute/connect-express")) {
        licenroute.present = true; licenroute.sdk = "express"; licenroute.locations.push(...r.licenroute.locations); licenroute.licensed_paths = r.licenroute.licensedPaths; licenroute.licensed_routes = r.licenroute.licensedRoutes;
      }
    }
  }

  // --- Rails -------------------------------------------------------------------------------------------------------
  const railsDeclared = gemfile !== null && /^\s*gem\s+["'](rails|railties)["']/m.test(gemfile);
  if (railsDeclared || reader.exists("config/routes.rb")) {
    const r = analyzeRails(reader);
    const version = r.version ?? railsVersion(reader);
    const mj = major(version);
    frameworks.push({ name: "rails", version: version ? sanitize(version, 40) : null, major: mj, supported: mj === 7 || mj === 8, language: "ruby", api_only: r.apiOnly, entry_files: r.routeFiles });
    if (mj !== null && mj !== 7 && mj !== 8) notes.push(tc("detect.rails_unsupported", { mj }));
    if (!reader.exists("config/routes.rb")) notes.push(r.routeFiles.includes("config.ru") ? tc("detect.rails_config_ru") : tc("detect.rails_no_routes"));
    routes.push(...r.routes); unresolved.push(...r.unresolved); unparseable.push(...r.unparseable);
    if (r.licenroute.locations.length > 0 || (gemfile !== null && /^\s*gem\s+["']botgate-connect["']/m.test(gemfile))) {
      licenroute.present = true; licenroute.sdk = licenroute.sdk ?? "rails"; licenroute.locations.push(...r.licenroute.locations);
      licenroute.licensed_paths = licenroute.licensed_paths ?? r.licenroute.licensedPaths;
      // El SDK de Rails aún no admite métodos: cada patrón exige licencia en todos.
      licenroute.licensed_routes = licenroute.licensed_routes ?? (r.licenroute.licensedPaths ? r.licenroute.licensedPaths.map((pattern) => ({ pattern, methods: [] })) : null);
    }
  }

  if (frameworks.length === 0) {
    const nested = reader.list((p) => /^[^/]+\/(?:[^/]+\/)?(?:package\.json|Gemfile)$/.test(p)).slice(0, 10);
    notes.push(nested.length > 0 ? tc("detect.nested", { p1: nested.join(", ") }) : tc("detect.none"));
  }

  const unresolvedCount = unresolved.length + routes.filter((r) => r.resolution !== "static").length;
  return {
    schema: "licenroute.cli.detect/v1",
    tool: TOOL,
    frameworks,
    licenroute,
    routes: routes.sort((a, b) => (a.source.file === b.source.file ? a.source.line - b.source.line : a.source.file < b.source.file ? -1 : 1)),
    unresolved,
    skipped: { ...reader.skipped, unparseable },
    notes,
    completeness: {
      complete: false,
      message: unresolvedCount > 0
        ? tc("detect.unresolved_count", { unresolvedCount })
        : tc("detect.no_guarantee"),
    },
    files: reader.files(),
  };
}
