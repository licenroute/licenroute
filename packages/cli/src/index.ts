// API programática de @licenroute/cli (S5): las mismas funciones que `licenroute detect` y `licenroute plan`, solo lectura.
export { detect, TOOL_VERSION } from "./detect.ts";
export { plan, PlanError } from "./plan.ts";
export { renderDetect, renderPlan } from "./render.ts";
export * as schema from "./schema.ts";
