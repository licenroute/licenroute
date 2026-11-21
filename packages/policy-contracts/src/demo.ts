/**
 * Modo demo (S10.1): credenciales y marcas de la SIMULACIÓN local. Nunca son credenciales comerciales.
 *  - Formatos propios, incompatibles con los reales: Central (Decision API y Rails) solo acepta `bg_(live|test)_`,
 *    `site_` sin un segundo `_` y licencias `bgat_`; el simulador solo acepta los de aquí. Ninguno se convierte en otro.
 *  - Toda respuesta del simulador lleva DEMO_MODE_HEADER = "simulation" (y DEMO_REASON_CODE en las decisiones). Un SDK
 *    en modo real rechaza cualquier respuesta con esa marca; un SDK en modo demo rechaza cualquiera sin ella.
 * No confundir con el prefijo SIM_ de los códigos de razón (reglas en modo observación, otra cosa).
 */
export const DEMO_API_KEY_FORMAT = /^bg_dev_[a-z2-7]{8}_[A-Za-z0-9]{43}$/;
export const DEMO_SITE_ID_FORMAT = /^site_dev_[A-Za-z0-9]{8,24}$/;
export const DEMO_ACCESS_TOKEN_FORMAT = /^bgdev_[a-z2-7]{8}_[A-Za-z0-9]{43}$/;
export const DEMO_MODE_HEADER = "botgate-mode";
export const DEMO_MODE_VALUE = "simulation";
export const DEMO_REASON_CODE = "DEMO_SIMULATOR";
/** Variable de entorno que el proceso de la app debe tener para aceptar credenciales de demo (segundo factor). */
export const DEMO_MODE_ENV = "LICENROUTE_MODE";

/** Formatos reales (copiados de Central para que el simulador los rechace; Central sigue siendo la fuente). */
export const REAL_API_KEY_FORMAT = /^bg_(live|test)_[a-z2-7]{8}_[A-Za-z0-9]{43}$/;
export const REAL_ACCESS_TOKEN_FORMAT = /^bgat_[a-z2-7]{8}_[A-Za-z0-9]{43}$/;

export const isDemoApiKey = (v: unknown): boolean => typeof v === "string" && DEMO_API_KEY_FORMAT.test(v);
export const isDemoSiteId = (v: unknown): boolean => typeof v === "string" && DEMO_SITE_ID_FORMAT.test(v);

/**
 * Señales de que el proceso corre en producción o en una plataforma de despliegue. No dependen solo de NODE_ENV:
 * un proceso con cualquiera de ellas nunca acepta el modo demo.
 */
export const PRODUCTION_SIGNALS = ["KUBERNETES_SERVICE_HOST", "ECS_CONTAINER_METADATA_URI", "ECS_CONTAINER_METADATA_URI_V4", "AWS_EXECUTION_ENV", "AWS_LAMBDA_FUNCTION_NAME", "K_SERVICE", "FUNCTION_TARGET", "WEBSITE_INSTANCE_ID", "DYNO", "FLY_APP_NAME", "RENDER", "RAILWAY_ENVIRONMENT", "VERCEL", "NETLIFY", "HEROKU_APP_ID"] as const;

export function productionSignals(env: Record<string, string | undefined>): string[] {
  const found: string[] = PRODUCTION_SIGNALS.filter((k) => env[k] !== undefined && env[k] !== "");
  if (env.NODE_ENV === "production") found.unshift("NODE_ENV=production");
  return found;
}

/** Loopback de verdad: solo 127.0.0.1, ::1 y localhost (sin subdominios, sin 0.0.0.0). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}
