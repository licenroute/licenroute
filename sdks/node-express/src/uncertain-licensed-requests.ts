import { createHash } from "node:crypto";

/**
 * BL-16: allow a bounded replay through an open breaker only if THIS SDK
 * previously observed an uncertain licensed response for the same request.
 * Never store the buyer token; bind request ID to method, route and token hash.
 */
export class UncertainLicensedRequests {
  private readonly entries = new Map<string, { fingerprint: string; expires: number; replays: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  constructor(ttlMs = 120_000, maxEntries = 2_000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  private fingerprint(method: string, path: string, token: string): string {
    return createHash("sha256").update(method).update("\0").update(path).update("\0").update(token).digest("hex");
  }

  mark(id: string, method: string, path: string, token: string, now = Date.now()): void {
    const fingerprint = this.fingerprint(method, path, token);
    const previous = this.entries.get(id);
    if (previous && previous.expires > now && previous.fingerprint === fingerprint) return;
    this.entries.delete(id);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(id, { fingerprint, expires: now + this.ttlMs, replays: 0 });
  }

  consume(id: string, method: string, path: string, token: string, now = Date.now()): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.expires <= now) {
      this.entries.delete(id);
      return false;
    }
    if (entry.fingerprint !== this.fingerprint(method, path, token) || entry.replays >= 2) return false;
    entry.replays++;
    return true;
  }

  forget(id: string): void {
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }
}
