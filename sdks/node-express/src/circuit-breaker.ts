/**
 * Circuit breaker: tras `failureThreshold` fallos en `windowMs` se abre y las
 * peticiones aplican el fallback sin esperar a la red. Pasado el tiempo de apertura, una única
 * petición de prueba (medio abierto): si va bien se cierra; si falla, se vuelve a abrir con el
 * DOBLE de tiempo, hasta `maxOpenMs`.
 *
 * Fase 7: con una apertura fija de 30 s, un pico de medio segundo (API o app recién arrancadas)
 * dejaba 30 s sin protección (fail_open) o con 503 (fail_closed). Ahora un pico cuesta `openMs`
 * (2 s por defecto) y una caída real converge a una prueba cada `maxOpenMs` (10 s): tras recuperarse
 * la API, la protección vuelve en ≤ 10 s (con un máximo de 30 s, el laboratorio midió ~24 s).
 */
export type BreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private failures: number[] = [];
  private openedAt: number | null = null;
  private currentOpenMs: number;
  private trialInFlight = false;
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly openMs: number;
  private readonly maxOpenMs: number;

  constructor(opts: { failureThreshold: number; windowMs: number; openMs: number; maxOpenMs?: number }) {
    this.failureThreshold = opts.failureThreshold;
    this.windowMs = opts.windowMs;
    this.openMs = opts.openMs;
    this.maxOpenMs = Math.max(opts.maxOpenMs ?? opts.openMs, opts.openMs);
    this.currentOpenMs = opts.openMs;
  }

  state(now = Date.now()): BreakerState {
    if (this.openedAt === null) return "closed";
    return now - this.openedAt >= this.currentOpenMs ? "half_open" : "open";
  }

  /** Tiempo de apertura vigente (crece mientras las pruebas fallan). */
  get openDurationMs(): number {
    return this.currentOpenMs;
  }

  /** ¿Puede salir esta petición hacia la API? */
  allowRequest(now = Date.now()): boolean {
    const state = this.state(now);
    if (state === "closed") return true;
    if (state === "open" || this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  success(): void {
    this.failures = [];
    this.openedAt = null;
    this.trialInFlight = false;
    this.currentOpenMs = this.openMs;
  }

  failure(now = Date.now()): void {
    if (this.trialInFlight || this.state(now) !== "closed") {
      // Falló la prueba (o una petición que salió antes de abrirse): reabrir con backoff.
      if (this.trialInFlight) this.currentOpenMs = Math.min(this.currentOpenMs * 2, this.maxOpenMs);
      this.openedAt = now;
      this.trialInFlight = false;
      return;
    }
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.failureThreshold) {
      this.openedAt = now;
      this.failures = [];
    }
  }
}
