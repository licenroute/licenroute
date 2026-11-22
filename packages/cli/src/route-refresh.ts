/** Pure helper for `licenroute test` (BL-34): no I/O, safe to load in the static phase. */
/** BL-34: routes the code has now under an approved pattern and methods, compared with the ones recorded at apply time. */
export function refreshPlanRoutes<P extends { pattern: string; methods: string[]; routes: { method: string; path: string }[] }>(
  plans: P[], current: { method: string; path: string }[], covers: (pattern: string, path: string) => boolean,
): { plans: P[]; changes: { plan: string; added: string[]; removed: string[] }[] } {
  const changes: { plan: string; added: string[]; removed: string[] }[] = [];
  const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
  const out = plans.map((p) => {
    const charged = (m: string) => (p.methods.length ? p.methods.includes(m) || m === "ALL" : true);
    const now = current.filter((r) => covers(p.pattern, r.path) && charged(r.method)).map((r) => ({ method: r.method, path: r.path }));
    const before = new Set(p.routes.map(key)); const after = new Set(now.map(key));
    const added = now.filter((r) => !before.has(key(r))).map((r) => r.path); const removed = p.routes.filter((r) => !after.has(key(r))).map((r) => r.path);
    if (now.length && (added.length || removed.length)) { changes.push({ plan: p.pattern, added, removed }); return { ...p, routes: now }; }
    return p;
  });
  return { plans: out, changes };
}

