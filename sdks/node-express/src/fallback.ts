import { matchGlob, type CompiledGlob, type Fallback } from "@licenroute/policy-contracts";

/**
 * Fallback efectivo cuando la Decision API no da una decisión (BL-11). Función pura,
 * gemela de Botgate::FallbackResolver (Ruby) y probada con fixtures/policy-fallback.json.
 *
 * Orden (lo primero que aplica gana):
 *  1. ruta de pago declarada en local (`licensedPaths`, con su método) -> fail_closed SIEMPRE;
 *  2. ruta licenciada de cualquier política verificada vista (aunque haya caducado) -> fail_closed;
 *  3. con política confiable: fallback de la primera regla que coincide;
 *  4. sin política confiable y (modo estricto, configuración insegura o petición con token) -> fail_closed;
 *  5. `routeFallbacks` locales; 6. `fallback` global; 7. fallback por defecto de la política confiable; 8. fail_open.
 * Ninguna regla puede abrir lo que una anterior cerró: las rutas de pago nunca se sirven gratis.
 */
export interface MethodGlob {
  glob: CompiledGlob;
  /** Vacío = todos los métodos. */
  methods: ReadonlySet<string>;
}

export interface FallbackState {
  /** Declaraciones locales (`licensedPaths`) con sus métodos; vacío = todos (D4.1). */
  localLicensed: MethodGlob[];
  /** Rutas licenciadas de cualquier política verificada (también caducada). */
  knownLicensed: MethodGlob[];
  /** Política verificada y no caducada; null si no hay. */
  trusted: { ruleFallbacks: (MethodGlob & { fallback: Fallback })[]; defaultFallback: Fallback | null } | null;
  withoutPolicy: "fallback" | "deny";
  /** La política tiene rutas de pago que `licensedPaths` no cubre. */
  unsafeConfig: boolean;
  routeFallbacks: { glob: CompiledGlob; fallback: Fallback }[];
  fallback: Fallback | null;
}

export type FallbackReason =
  | "licensed_local" | "licensed_policy" | "policy_rule" | "no_policy_strict" | "no_policy_unsafe_config"
  | "no_policy_token" | "route_fallback" | "global_fallback" | "policy_default" | "default";

export function resolveFallback(state: FallbackState, req: { path: string; method: string; hasToken: boolean }): { fallback: Fallback; reason: FallbackReason } {
  const methodOk = (methods: ReadonlySet<string>) => methods.size === 0 || methods.has(req.method);
  if (state.localLicensed.some((l) => methodOk(l.methods) && matchGlob(l.glob, req.path))) return { fallback: "fail_closed", reason: "licensed_local" };
  if (state.knownLicensed.some((l) => methodOk(l.methods) && matchGlob(l.glob, req.path))) return { fallback: "fail_closed", reason: "licensed_policy" };
  if (state.trusted) {
    const rule = state.trusted.ruleFallbacks.find((r) => methodOk(r.methods) && matchGlob(r.glob, req.path));
    if (rule) return { fallback: rule.fallback, reason: "policy_rule" };
  } else {
    if (state.withoutPolicy === "deny") return { fallback: "fail_closed", reason: "no_policy_strict" };
    if (state.unsafeConfig) return { fallback: "fail_closed", reason: "no_policy_unsafe_config" };
    if (req.hasToken) return { fallback: "fail_closed", reason: "no_policy_token" };
  }
  const route = state.routeFallbacks.find((r) => matchGlob(r.glob, req.path));
  if (route) return { fallback: route.fallback, reason: "route_fallback" };
  if (state.fallback) return { fallback: state.fallback, reason: "global_fallback" };
  if (state.trusted?.defaultFallback) return { fallback: state.trusted.defaultFallback, reason: "policy_default" };
  return { fallback: "fail_open", reason: "default" };
}

/** Compartida con la API, el worker y el panel (policy-contracts). */
export { coversLicensed } from "@licenroute/policy-contracts";
