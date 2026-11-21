import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { assertModeMarker } from "./api-client.ts";
import { matchGlob, type CompiledGlob, type Fallback, type PolicyDocumentBody } from "@licenroute/policy-contracts";
import type { Logger } from "./options.ts";
import { randomUUID } from "node:crypto";
import { SDK_USER_AGENT, SDK_VERSION } from "./api-client.ts";
import type { FallbackState, MethodGlob } from "./fallback.ts";
import { localizedChecksum, localizedGlob, m } from "./messages.ts";

interface SyncedPolicy {
  version: number;
  etag: string | null;
  /** null: el sitio no tiene política publicada (404). */
  defaultFallback: Fallback | null;
  excluded: CompiledGlob[];
  licensed: MethodGlob[];
  licensedPatterns: string[];
  ruleFallbacks: (MethodGlob & { fallback: Fallback })[];
}

interface CacheFile {
  site_id: string;
  verified_at: number;
  etag: string | null;
  checksum: string;
  document: PolicyDocumentBody;
}

export interface PolicySyncOptions {
  fetch: typeof fetch;
  endpoint: string;
  apiKey: string;
  siteId: string;
  timeoutMs: number;
  logger: Logger;
  /** Antigüedad máxima de una política sin poder reverificarla (BL-11). */
  maxAgeMs: number;
  /** Fichero donde persistir la última política verificada (opcional). */
  cachePath: string | null;
  /** Modo del SDK: las respuestas deben llevar (demo) o no llevar (real) la marca de simulación. */
  mode?: "live" | "demo";
  /** Declaración de esta instancia para POST /v1/sdk/attestations (BL-11). */
  attestation?: { instanceId: string; licensedPaths: string[]; withoutPolicy: "fallback" | "deny"; identityKeyId?: string | null };
}

/**
 * Copia local de la política publicada (F3-08): GET /v1/policies/current con
 * If-None-Match; antes de aceptar un documento se verifica site_id y checksum (JSON canónico).
 * Se usa para exclusiones y para el fallback por ruta cuando la API no responde.
 * NO evalúa reglas en local: las decisiones las toma siempre la Decision API.
 *
 * BL-11 (Fase 8):
 *  - una política es CONFIABLE si se verificó (200 o 304) hace menos de `maxAgeMs`;
 *  - las rutas licenciadas de cualquier política verificada se recuerdan aunque caduque: solo
 *    sirven para cerrar, nunca para abrir;
 *  - con `cachePath`, la última política verificada se guarda (0600) y se carga al arrancar,
 *    tras volver a comprobar sitio y checksum. Un fichero corrupto o de otro sitio se ignora.
 */
export class PolicySync {
  private current: SyncedPolicy | null = null;
  private verifiedAt = 0;
  private lastWrite = 0;
  private knownLicensed: MethodGlob[] = [];
  private knownLicensedPatterns: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: PolicySyncOptions;

  constructor(opts: PolicySyncOptions) {
    this.opts = opts;
    if (opts.cachePath) this.loadCache(opts.cachePath);
  }

  /**
   * Refresco periódico. Mientras no haya política confiable (arranque con la API caída), reintenta
   * cada 5 s en vez de esperar el intervalo completo: sus rutas de pago y exclusiones llegan en
   * cuanto la API vuelve (BL-11).
   */
  start(intervalMs: number): void {
    let stopped = false;
    const tick = async () => {
      await this.refresh();
      await this.attest();
      if (stopped) return;
      this.timer = setTimeout(() => void tick(), this.trusted() ? intervalMs : Math.min(5_000, intervalMs));
      this.timer.unref();
    };
    this.stopTick = () => { stopped = true; };
    void tick();
  }

  stop(): void {
    this.stopTick();
    if (this.timer) clearTimeout(this.timer);
  }

  private stopTick: () => void = () => {};

  get version(): number | null {
    return this.current?.version ?? null;
  }

  /** Política verificada y no caducada, o null. */
  trusted(now = Date.now()): SyncedPolicy | null {
    return this.current && now - this.verifiedAt <= this.opts.maxAgeMs ? this.current : null;
  }

  /** Patrones licenciados de la política más reciente verificada (aunque haya caducado). */
  get licensedPatterns(): string[] {
    return this.knownLicensedPatterns;
  }

  /** Estado para resolveFallback (las opciones locales las añade el middleware). */
  fallbackState(now = Date.now()): Pick<FallbackState, "knownLicensed" | "trusted"> {
    const t = this.trusted(now);
    return { knownLicensed: this.knownLicensed, trusted: t ? { ruleFallbacks: t.ruleFallbacks, defaultFallback: t.defaultFallback } : null };
  }

  /** Devuelve true si la política quedó actualizada (o sin cambios). Nunca lanza. */
  async refresh(): Promise<boolean> {
    const { fetch: fetchImpl, endpoint, apiKey, timeoutMs, logger } = this.opts;
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, "user-agent": SDK_USER_AGENT };
      if (this.current?.etag) headers["if-none-match"] = this.current.etag;
      const res = await fetchImpl(`${endpoint}/v1/policies/current`, { headers, signal: AbortSignal.timeout(Math.max(timeoutMs, 2_000)), redirect: "error" });
      // También en 304 y 404: un 404 haría confiar en una política vacía, así que tampoco vale del servicio equivocado.
      assertModeMarker(this.opts.mode ?? "live", res.headers, m("api.what.policy"));
      if (res.status === 304) {
        this.verifiedAt = Date.now();
        this.touchCache();
        return true;
      }
      const text = await res.text();
      if (res.status === 404) {
        // Sitio sin política publicada: confiable y vacía (la API no tiene rutas de pago que proteger).
        this.current = { version: 0, etag: null, defaultFallback: null, excluded: [], licensed: [], licensedPatterns: [], ruleFallbacks: [] };
        this.verifiedAt = Date.now();
        this.setKnownLicensed([]);
        return true;
      }
      if (res.status !== 200) {
        logger.warn({ status: res.status }, m("policy.sync_failed"));
        return false;
      }
      const { checksum, ...document } = JSON.parse(text) as PolicyDocumentBody & { checksum: string };
      this.accept(document, checksum, res.headers.get("etag"), Date.now());
      this.writeCache(document, checksum);
      return true;
    } catch (error) {
      logger.warn({ err: (error as Error).message }, m("policy.rejected"));
      return false;
    }
  }

  /** Identificador de este arranque (cambia en cada reinicio del proceso). */
  readonly bootId = randomUUID();

  /**
   * Atestación (BL-11): declara a LicenRoute qué rutas de pago protege esta instancia. Se envía al
   * arrancar y en cada sincronización. Nunca lanza: si falla, el tráfico no se ve afectado (pero el
   * panel no podrá activar el cobro mientras no haya atestaciones recientes).
   */
  async attest(): Promise<boolean> {
    const a = this.opts.attestation;
    if (!a) return false;
    const { fetch: fetchImpl, endpoint, apiKey, timeoutMs, logger } = this.opts;
    try {
      const res = await fetchImpl(`${endpoint}/v1/sdk/attestations`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "user-agent": SDK_USER_AGENT, "content-type": "application/json" },
        body: JSON.stringify({ instance_id: a.instanceId, boot_id: this.bootId, sdk: "express", sdk_version: SDK_VERSION, licensed_paths: a.licensedPaths, without_policy: a.withoutPolicy, ...(a.identityKeyId ? { identity_key_id: a.identityKeyId } : {}) }),
        signal: AbortSignal.timeout(Math.max(timeoutMs, 2_000)),
        redirect: "error",
      });
      await res.text();
      assertModeMarker(this.opts.mode ?? "live", res.headers, m("api.what.attestation"));
      if (res.status !== 204) logger.warn({ status: res.status }, m("policy.attestation_rejected"));
      return res.status === 204;
    } catch (error) {
      logger.warn({ err: (error as Error).message }, m("policy.attestation_not_sent"));
      return false;
    }
  }

  isExcluded(path: string): boolean {
    // Las exclusiones solo de una política confiable: una caducada podría excluir de más.
    return this.trusted()?.excluded.some((g) => matchGlob(g, path)) ?? false;
  }

  get defaultFallback(): Fallback | null {
    return this.trusted()?.defaultFallback ?? null;
  }

  private accept(document: PolicyDocumentBody, checksum: string, etag: string | null, verifiedAt: number): void {
    if (document.site_id !== this.opts.siteId) throw new Error(m("policy.other_site"));
    if (localizedChecksum(document) !== checksum) throw new Error(m("policy.bad_checksum"));
    this.current = compile(document, etag);
    this.verifiedAt = verifiedAt;
    this.setKnownLicensed(this.current.licensed, this.current.licensedPatterns);
  }

  private setKnownLicensed(licensed: MethodGlob[], patterns: string[] = []): void {
    this.knownLicensed = licensed;
    this.knownLicensedPatterns = patterns;
  }

  private loadCache(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return; // primera instalación: sin caché
    }
    try {
      const c = JSON.parse(raw) as CacheFile;
      const verifiedAt = Number(c.verified_at);
      if (!Number.isFinite(verifiedAt)) throw new Error(m("policy.bad_verified_at"));
      this.accept(c.document, c.checksum, c.etag ?? null, verifiedAt);
      if (!this.trusted()) this.opts.logger.warn({ verified_at: new Date(verifiedAt).toISOString() }, m("policy.stale"));
    } catch (error) {
      this.current = null;
      this.verifiedAt = 0;
      this.setKnownLicensed([]);
      this.opts.logger.warn({ err: (error as Error).message }, m("policy.unusable"));
    }
  }

  private writeCache(document: PolicyDocumentBody, checksum: string): void {
    const path = this.opts.cachePath;
    if (!path) return;
    const payload: CacheFile = { site_id: this.opts.siteId, verified_at: this.verifiedAt, etag: this.current?.etag ?? null, checksum, document };
    try {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path); // escritura atómica
      this.lastWrite = Date.now();
    } catch (error) {
      this.opts.logger.warn({ err: (error as Error).message }, m("policy.not_saved"));
    }
  }

  /** Tras un 304, refresca verified_at en disco como mucho cada 10 min. */
  private touchCache(): void {
    if (!this.opts.cachePath || !this.current || Date.now() - this.lastWrite < 10 * 60_000) return;
    try {
      const c = JSON.parse(readFileSync(this.opts.cachePath, "utf8")) as CacheFile;
      this.writeCache(c.document, c.checksum);
    } catch {
      // sin caché previa legible: se reescribirá con el próximo 200
    }
  }
}

function compile(document: PolicyDocumentBody, etag: string | null): SyncedPolicy {
  const routes = (document.licensed_routes as { route_pattern?: string; methods?: string[] }[]).filter((r) => typeof r.route_pattern === "string");
  return {
    version: document.version,
    etag,
    defaultFallback: document.defaults.fallback,
    excluded: document.defaults.excluded_paths.map(localizedGlob),
    licensed: routes.map((r) => ({ glob: localizedGlob(r.route_pattern!), methods: new Set(r.methods ?? []) })),
    licensedPatterns: routes.map((r) => r.route_pattern!),
    ruleFallbacks: [...document.rules]
      .sort((a, b) => a.priority - b.priority)
      .filter((r) => r.fallback !== null)
      .map((r) => ({ glob: localizedGlob(r.path_pattern), methods: new Set(r.methods), fallback: r.fallback! })),
  };
}
