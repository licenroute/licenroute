import { DEMO_MODE_HEADER, DEMO_MODE_VALUE, DEMO_REASON_CODE, type DecisionRequest } from "@licenroute/policy-contracts";
import { m } from "./messages.ts";

const ACTIONS = new Set(["allow", "block", "rate_limit", "challenge", "payment_required"]);
export const SDK_VERSION = "0.8.1";
export const SDK_USER_AGENT = `licenroute-connect-express/${SDK_VERSION}`;

export interface Decision {
  request_id: string;
  action: "allow" | "block" | "rate_limit" | "challenge" | "payment_required";
  risk_score: number;
  reason_codes: string[];
  policy_version: number;
  ttl_seconds: number;
  retry_after_seconds?: number;
  payment?: Record<string, unknown>;
}

/** La API no dio una decisión utilizable (red, timeout, HTTP != 200, cuerpo inválido). */
export class DecisionUnavailableError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

const isInt = (v: unknown, min: number) => Number.isInteger(v) && (v as number) >= min;

/**
 * Solo una respuesta 200 con una decisión válida es una decisión. Un 429 o 5xx de la PROPIA API
 * es un fallo del servicio (se aplica el fallback), nunca un `rate_limit` para el cliente (F3-13).
 */
export function parseDecision(status: number, contentType: string | null, text: string): Decision {
  if (status !== 200) throw new DecisionUnavailableError(m("api.http_status", { status }), status);
  if (!contentType?.includes("application/json")) throw new DecisionUnavailableError(m("api.not_json"), status);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new DecisionUnavailableError(m("api.invalid_json"), status);
  }
  const d = body as Partial<Decision>;
  if (
    !d || typeof d !== "object" || !ACTIONS.has(d.action as string) || typeof d.request_id !== "string" ||
    !isInt(d.risk_score, 0) || !Array.isArray(d.reason_codes) || !isInt(d.policy_version, 0) || !isInt(d.ttl_seconds, 0)
  ) {
    throw new DecisionUnavailableError(m("api.invalid_decision"), status);
  }
  if (d.retry_after_seconds !== undefined && !isInt(d.retry_after_seconds, 1)) delete d.retry_after_seconds;
  return d as Decision;
}

/**
 * Una respuesta solo vale en su modo: en demo debe llevar la marca de simulación; en modo real, ninguna. Lo contrario
 * es un servicio que no es el configurado: se trata como no disponible (se aplica el fallback, cerrado en rutas de pago).
 */
export function assertModeMarker(mode: "live" | "demo", headers: Headers, what: string): void {
  const marked = headers.get(DEMO_MODE_HEADER) !== null;
  if (mode === "demo" && headers.get(DEMO_MODE_HEADER) !== DEMO_MODE_VALUE) throw new DecisionUnavailableError(m("api.unmarked_response", { what }));
  if (mode === "live" && marked) throw new DecisionUnavailableError(m("api.simulator_live", { what }));
}

export async function requestDecision(
  fetchImpl: typeof fetch, endpoint: string, apiKey: string, timeoutMs: number, body: DecisionRequest,
  extraHeaders: Record<string, string> = {}, mode: "live" | "demo" = "live",
): Promise<Decision> {
  let response: Response;
  try {
    response = await fetchImpl(`${endpoint}/v1/decisions`, {
      method: "POST",
      // botgate-timeout-ms: la API no confirma un cargo que el SDK ya no va a esperar (Fase 7).
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "user-agent": SDK_USER_AGENT, "botgate-timeout-ms": String(timeoutMs), ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    throw new DecisionUnavailableError((error as Error).name === "TimeoutError" ? "timeout" : m("api.network_error"), null, { cause: error });
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new DecisionUnavailableError(m("api.read_timeout"), response.status, { cause: error });
  }
  assertModeMarker(mode, response.headers, m("api.what.decision"));
  const decision = parseDecision(response.status, response.headers.get("content-type"), text);
  const simulated = decision.reason_codes.includes(DEMO_REASON_CODE);
  if (mode === "demo" && !simulated) throw new DecisionUnavailableError(m("api.unmarked_decision"), response.status);
  if (mode === "live" && simulated) throw new DecisionUnavailableError(m("api.simulated_live"), response.status);
  return decision;
}
