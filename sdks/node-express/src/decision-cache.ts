import type { Decision } from "./api-client.ts";

/** Caché LRU de decisiones `allow` con ttl_seconds > 0 (F3-14). */
export class DecisionCache {
  private readonly entries = new Map<string, { decision: Decision; expiresAt: number }>();
  private readonly maxEntries: number;
  private readonly maxTtlSeconds: number;

  constructor(maxEntries: number, maxTtlSeconds: number) {
    this.maxEntries = maxEntries;
    this.maxTtlSeconds = maxTtlSeconds;
  }

  /** Solo `allow` y ttl > 0: block/rate_limit/payment nunca se reutilizan. */
  static cacheable(decision: Decision): boolean {
    return decision.action === "allow" && decision.ttl_seconds > 0;
  }

  get(key: string, now = Date.now()): Decision | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry); // LRU: al final = más reciente
    return entry.decision;
  }

  set(key: string, decision: Decision, now = Date.now()): void {
    if (!DecisionCache.cacheable(decision)) return;
    const ttl = Math.min(decision.ttl_seconds, this.maxTtlSeconds);
    this.entries.delete(key);
    this.entries.set(key, { decision, expiresAt: now + ttl * 1000 });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  get size(): number {
    return this.entries.size;
  }
}
