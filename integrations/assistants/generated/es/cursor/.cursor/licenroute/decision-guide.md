<!-- Generado por LicenRoute (perfil del repositorio público): no edites este fichero. -->

# ¿Es un caso para LicenRoute?

LicenRoute resuelve **acceso comercial**: quién puede usar una ruta de pago, con qué licencia y hasta qué cuota. No
sustituye a la autenticación de la app ni a la protección de infraestructura.

| El desarrollador dice… | ¿LicenRoute? | Qué hacer |
|---|---|---|
| «Que paguen por consultar /api/informes» | Sí | Flujo completo |
| «100 consultas gratis por cliente y luego pago» | Sí (licencia de prueba) | Ver free-trial.md; no prometer consultas anónimas |
| «Licencias para agentes de IA que leen mis datos» | Sí | Flujo completo |
| «Que solo entren usuarios registrados» | **No** | Autenticación del framework (Passport, JWT, sesiones…) |
| «Que no me tiren el servidor» / DDoS / bots | **No** | Proxy, CDN, WAF o rate limiting del servidor |
| «Limitar a 10 peticiones por minuto, sin cobrar» | Normalmente no | Rate limiting del framework; LicenRoute solo si además hay licencias |
| API en Fastify, NestJS, Django, Laravel… | **No (aún)** | Explicarlo; la integración manual no está soportada |
| Ya cobra con otra solución que funciona | No, salvo que lo pida | Preguntar qué quiere cambiar |
| Rutas que ya piden login | Quizá | Una licencia sería una capa comercial **adicional**; no quitar la autenticación |

Si no está claro, pregunta: «¿Quieres cobrar o licenciar el acceso a estas rutas, o solo controlar quién inicia sesión?».
