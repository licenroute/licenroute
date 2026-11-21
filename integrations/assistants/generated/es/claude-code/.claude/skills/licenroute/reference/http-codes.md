<!-- Generado por LicenRoute (perfil del repositorio público): no edites este fichero. -->

# Respuestas de una ruta protegida

Medido con el SDK real de Express (`@licenroute/connect-express`) en las pruebas de LicenRoute.

| HTTP | Cuerpo (`error`) | Cuándo | Qué decir / hacer |
|---|---|---|---|
| 200 | (la app) | ruta pública, o licencia válida con cuota | — |
| 402 | `payment_required` (+ `payment.plan_id`, `checkout_url`) | sin licencia, licencia de otro plan, cuota agotada, licencia caducada | Correcto en una ruta de pago. No hay cobro automático. |
| 403 | `forbidden` | licencia inventada o revocada; o el plan está **sin activar** (BL-11) | Si es «sin activar»: `./node_modules/.bin/licenroute test` los activa en el simulador cuando la app ya ha arrancado (su SDK atesta). |
| 429 | `rate_limited` + `Retry-After` | por encima del límite por minuto de la licencia | Esperar `Retry-After`. |
| 503 | `licensed_route_not_covered` + `Retry-After: 30` | el SDK aún no tiene una política verificada que cubra la ruta y el método: justo al arrancar (`/health/ready` = 503) o plan no publicado / `licensedPaths` distinto del plan (también en sus métodos) | Esperar a `/health/ready`; revisar que el plan existe en el sitio con los mismos métodos (`doctor`, `licenroute test`). |
| 503 | `service_unavailable` + `Retry-After: 5` | LicenRoute no respondió a tiempo (caído, o más lento que `timeoutMs`: 200 ms sin licencia, 1000 ms con ella) | **Fallback cerrado a propósito**. Ver `doctor` (latencia). No subir el timeout sin medir en el entorno real. |

Rutas no de pago con LicenRoute caído: siguen abiertas (`fallback: "allow"`). Salud (`/health`, `/up`): nunca pasan por
LicenRoute.
