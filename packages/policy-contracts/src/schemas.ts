/**
 * Esquemas de la API v1 (TypeBox -> JSON Schema). Fuente para validación en Fastify y tipos TS.
 * Las respuestas reales se validan además contra docs/api/openapi.yaml en las pruebas de contrato.
 */
import Type, { type Static } from "typebox";
import { MAX_PATH_LENGTH } from "./path.ts";

export const PublicSiteId = Type.String({ pattern: "^site_[A-Za-z0-9]{4,32}$" });

export const Action = Type.Union([
  Type.Literal("allow"),
  Type.Literal("block"),
  Type.Literal("rate_limit"),
  Type.Literal("challenge"),
  Type.Literal("payment_required"),
]);
export type Action = Static<typeof Action>;

export const ReasonCodeSchema = Type.String({ pattern: "^[A-Z][A-Z0-9_]{1,63}$" });

export const HttpMethod = Type.Union([
  Type.Literal("GET"),
  Type.Literal("HEAD"),
  Type.Literal("POST"),
  Type.Literal("PUT"),
  Type.Literal("PATCH"),
  Type.Literal("DELETE"),
  Type.Literal("OPTIONS"),
]);

export const DecisionRequest = Type.Object(
  {
    request_id: Type.String({ format: "uuid" }),
    site_id: PublicSiteId,
    timestamp: Type.String({ format: "date-time" }),
    method: HttpMethod,
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH, pattern: "^/" }),
    client: Type.Object(
      {
        // Opcional solo para conectores Publish: no tienen una IP verificada del consumidor. La Decision
        // API la sigue exigiendo a cualquier otro sitio, y sin IP no se aplica ninguna regla que dependa de ella.
        ip: Type.Optional(Type.String({ anyOf: [{ format: "ipv4" }, { format: "ipv6" }] })),
        user_agent: Type.Optional(Type.Union([Type.String({ maxLength: 512 }), Type.Null()])),
      },
      { additionalProperties: false },
    ),
    signals: Type.Optional(
      Type.Object(
        {
          session_present: Type.Optional(Type.Boolean()),
          authenticated_user: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    access_token: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Null()])),
    /**
     * LicenRoute Trust (Fase 10): identidad SEUDÓNIMA de un usuario autenticado por el SERVIDOR de la app
     * (opción identify() del SDK). hash = HMAC-SHA256(clave de identidad del sitio, "v1:<site_id>:<id>");
     * key_id = huella de esa clave. LicenRoute no recibe el id real; nunca proviene del navegador.
     */
    identity: Type.Optional(Type.Object(
      { hash: Type.String({ pattern: "^[0-9a-f]{64}$" }), key_id: Type.String({ pattern: "^[0-9a-f]{16}$" }) },
      { additionalProperties: false },
    )),
  },
  { additionalProperties: false },
);
export type DecisionRequest = Static<typeof DecisionRequest>;

export const PaymentInfo = Type.Object({
  plan_id: Type.String(),
  checkout_url: Type.String(),
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
  unit_price_minor: Type.Integer({ minimum: 0 }),
  unit_size: Type.Integer({ minimum: 1 }),
});
export type PaymentInfo = Static<typeof PaymentInfo>;

/** Publish I2: licencia concedida; solo en decisiones LICENSE_VALID para sitios publish_connector. */
export const LicenseGrantInfo = Type.Object(
  {
    grant_id: Type.String({ format: "uuid" }),
    plan_id: Type.String({ minLength: 1, maxLength: 64 }),
    data_scope: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$" }),
  },
  { additionalProperties: false },
);
export type LicenseGrantInfo = Static<typeof LicenseGrantInfo>;

export const DecisionResponse = Type.Object(
  {
    request_id: Type.String(),
    action: Action,
    risk_score: Type.Integer({ minimum: 0, maximum: 100 }),
    reason_codes: Type.Array(ReasonCodeSchema),
    policy_version: Type.Integer({ minimum: 0 }),
    ttl_seconds: Type.Integer({ minimum: 0 }),
    retry_after_seconds: Type.Optional(Type.Integer({ minimum: 1 })),
    payment: Type.Optional(PaymentInfo),
    license: Type.Optional(LicenseGrantInfo),
  },
  { additionalProperties: false },
);
export type DecisionResponse = Static<typeof DecisionResponse>;

export const Fallback = Type.Union([Type.Literal("fail_open"), Type.Literal("fail_closed")]);
export type Fallback = Static<typeof Fallback>;

export const RateLimitDimension = Type.Union([
  Type.Literal("site"),
  Type.Literal("route"),
  Type.Literal("ip"),
  Type.Literal("ip_prefix"),
  Type.Literal("identity"), // Fase 10: solo usuarios autenticados; sin identidad, la regla no aplica
  Type.Literal("client"), // Fase 10: agente verificado, usuario autenticado o, si no, la IP
]);

/** Clase de cliente (Fase 10): agente con credencial, usuario autenticado por el servidor o anónimo. */
export const ClientKind = Type.Union([Type.Literal("anonymous"), Type.Literal("authenticated"), Type.Literal("agent")]);
export type ClientKind = Static<typeof ClientKind>;

export const PolicyRule = Type.Object({
  id: Type.String(),
  priority: Type.Integer(),
  path_pattern: Type.String({ pattern: "^/" }),
  methods: Type.Array(Type.String()),
  conditions: Type.Object({
    ip_in: Type.Optional(Type.Array(Type.String())),
    ip_not_in: Type.Optional(Type.Array(Type.String())),
    session_present: Type.Optional(Type.Boolean()),
    client_kind: Type.Optional(Type.Array(ClientKind, { minItems: 1, maxItems: 3 })),
  }, { additionalProperties: false }),
  action: Type.Union([Type.Literal("allow"), Type.Literal("block"), Type.Literal("rate_limit"), Type.Literal("challenge")]),
  mode: Type.Union([Type.Literal("enforce"), Type.Literal("simulate")]),
  rate_limit: Type.Union([
    Type.Object({
      limit: Type.Integer({ minimum: 1 }),
      period_seconds: Type.Integer({ minimum: 1 }),
      burst: Type.Integer({ minimum: 0 }),
      dimension: RateLimitDimension,
    }),
    Type.Null(),
  ]),
  fallback: Type.Union([Fallback, Type.Null()]),
});
export type PolicyRule = Static<typeof PolicyRule>;

/** Ruta licenciada publicada desde un AccessPlan activo (Fase 5). */
export const LicensedRoute = Type.Object({
  plan_id: Type.String(),
  plan_uuid: Type.String(),
  route_pattern: Type.String({ pattern: "^/" }),
  methods: Type.Array(Type.String()),
  checkout_url: Type.String(),
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
  unit_price_minor: Type.Integer({ minimum: 0 }),
  unit_size: Type.Integer({ minimum: 1 }),
  /**
   * BL-11: "active" = cobro activado (402 sin licencia); "pending" = cobro sin activar y acceso
   * previo DENEGADO (403 LICENSE_NOT_ACTIVE). Un plan pendiente con acceso previo "libre" no se
   * publica. Ausente = "active" (documentos anteriores).
   */
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("pending")])),
});
export type LicensedRoute = Static<typeof LicensedRoute>;

/** Límites de la atestación del SDK (BL-11). */
export const ATTESTATION_MAX_PATHS = 100;

/**
 * POST /v1/sdk/attestations (BL-11): configuración de protección que DECLARA una instancia del SDK.
 * El sitio sale de la API key, nunca del cuerpo. No es una prueba criptográfica de que la instancia
 * proteja el tráfico: solo de lo que declara.
 */
/**
 * BL-11 para Publish: estado que DECLARA un Publish Connector de cada recurso que sirve. Es una
 * declaración autenticada con la clave del sitio, no una certificación de que la fuente sea segura.
 */
export const PublishResourceAttestation = Type.Object(
  {
    slug: Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }),
    version: Type.Integer({ minimum: 1 }),
    /** Planes de Central configurados en el conector para este recurso. */
    plan_ids: Type.Array(Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }), { minItems: 1, maxItems: 20 }),
    checks: Type.Object(
      {
        schema: Type.Union([Type.Literal("ok"), Type.Literal("failed")]),
        /** "small": sin índice utilizable pero por debajo del umbral permitido (B2). */
        index: Type.Union([Type.Literal("optimal"), Type.Literal("usable"), Type.Literal("small"), Type.Literal("missing"), Type.Literal("failed")]),
        source_role: Type.Union([Type.Literal("read_only"), Type.Literal("unsafe"), Type.Literal("failed")]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type PublishResourceAttestation = Static<typeof PublishResourceAttestation>;
export const PublishAttestation = Type.Object(
  { resources: Type.Array(PublishResourceAttestation, { minItems: 1, maxItems: ATTESTATION_MAX_PATHS }) },
  { additionalProperties: false },
);
export type PublishAttestation = Static<typeof PublishAttestation>;

/** Rutas que cubre un conector: exactamente /api/v1/<slug>/** por recurso (ni más ni menos). */
export function publishAttestationPaths(publish: PublishAttestation): string[] {
  return publish.resources.map((r) => `/api/v1/${r.slug}/**`);
}
/** Un recurso cuenta como preparado solo si TODAS sus comprobaciones declaradas son correctas. */
export function publishResourceReady(resource: PublishResourceAttestation): boolean {
  const { schema, index, source_role } = resource.checks;
  return schema === "ok" && source_role === "read_only" && (index === "optimal" || index === "usable" || index === "small");
}

export const SdkAttestationRequest = Type.Object(
  {
    instance_id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" }),
    boot_id: Type.String({ format: "uuid" }),
    /** "publish_connector" solo desde sitios publish_connector (la API exige que coincida con sites.kind). */
    sdk: Type.Union([Type.Literal("express"), Type.Literal("rails"), Type.Literal("publish_connector")]),
    sdk_version: Type.String({ minLength: 1, maxLength: 32, pattern: "^[0-9A-Za-z.+-]+$" }),
    licensed_paths: Type.Array(Type.String({ minLength: 1, maxLength: 512, pattern: "^/" }), { maxItems: ATTESTATION_MAX_PATHS }),
    without_policy: Type.Union([Type.Literal("fallback"), Type.Literal("deny")]),
    /** Fase 10: huella de la clave de identidad que usa la instancia (el panel detecta instancias desincronizadas). */
    identity_key_id: Type.Optional(Type.String({ pattern: "^[0-9a-f]{16}$" })),
    /** Obligatorio con sdk "publish_connector" y prohibido con los SDK (la API lo comprueba). */
    publish: Type.Optional(PublishAttestation),
  },
  { additionalProperties: false },
);
export type SdkAttestationRequest = Static<typeof SdkAttestationRequest>;

/** Documento tal como se guarda en policy_versions.document (sin checksum). */
export const PolicyDocumentBody = Type.Object({
  site_id: PublicSiteId,
  version: Type.Integer({ minimum: 1 }),
  published_at: Type.String(),
  defaults: Type.Object({
    fallback: Fallback,
    score_thresholds: Type.Object({
      observe: Type.Integer({ minimum: 0, maximum: 100 }),
      rate_limit: Type.Integer({ minimum: 0, maximum: 100 }),
      block: Type.Integer({ minimum: 0, maximum: 100 }),
    }),
    excluded_paths: Type.Array(Type.String({ pattern: "^/" })),
  }),
  rules: Type.Array(PolicyRule),
  licensed_routes: Type.Array(LicensedRoute),
});
export type PolicyDocumentBody = Static<typeof PolicyDocumentBody>;

export const Problem = Type.Object({
  type: Type.String(),
  title: Type.String(),
  status: Type.Integer(),
  detail: Type.Optional(Type.String()),
  request_id: Type.Optional(Type.String()),
  errors: Type.Optional(Type.Array(Type.Object({ path: Type.String(), message: Type.String() }))),
});
export type Problem = Static<typeof Problem>;

/** Evento enviado por un SDK en POST /v1/events/batch (p. ej. decisiones por fallback). */
export const DecisionEvent = Type.Object(
  {
    request_id: Type.String({ format: "uuid" }),
    occurred_at: Type.String({ format: "date-time" }),
    method: HttpMethod,
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH, pattern: "^/" }),
    action: Action,
    reason_codes: Type.Array(ReasonCodeSchema, { maxItems: 32 }),
    risk_score: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()])),
    policy_version: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    rule_id: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
    fallback: Type.Optional(Type.Boolean()),
    client_ip: Type.Optional(Type.Union([Type.String({ anyOf: [{ format: "ipv4" }, { format: "ipv6" }] }), Type.Null()])),
  },
  { additionalProperties: false },
);
export type DecisionEvent = Static<typeof DecisionEvent>;

/** El sobre se valida en bloque; cada evento por separado (los inválidos se rechazan uno a uno). */
export const EventsBatchRequest = Type.Object(
  { events: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 500 }) },
  { additionalProperties: false },
);

export const EventsBatchResponse = Type.Object({
  accepted: Type.Integer({ minimum: 0 }),
  duplicates: Type.Integer({ minimum: 0 }),
  rejected: Type.Array(Type.Object({ index: Type.Integer(), reason: Type.String() })),
});
export type EventsBatchResponse = Static<typeof EventsBatchResponse>;

export const SiteMetricsQuery = Type.Object(
  {
    from: Type.String({ format: "date-time" }),
    to: Type.String({ format: "date-time" }),
    granularity: Type.Optional(Type.Union([Type.Literal("hour"), Type.Literal("day")])),
  },
  { additionalProperties: false },
);
