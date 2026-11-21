<!-- Generado por LicenRoute (perfil del repositorio público): no edites este fichero. -->

# Licencia de prueba gratuita (MVP)

**Qué es**: un plan del propietario, sin coste, con una cuota total por licencia (p. ej. 100 consultas). El
propietario emite **una licencia a un comprador identificado**; sin tarjeta, sin renovación y sin cobro: al agotarse,
la ruta responde 402 y no se carga nada.

**Cómo se expresa hoy** (sin desarrollo nuevo):

- Plan `paid` con `unit_price_minor = 0`, `quota_units = 100` y una `duration_days` (la licencia caduca; no se renueva).
- El propietario decide si lo ofrece y emite la licencia desde el panel a un comprador aprobado.
- Puede convivir con un plan de pago en la misma ruta: el comprador usa la licencia que tenga.

**Lo que NO existe** (no lo prometas): consultas anónimas sin licencia, registro o emisión automática de licencias de
prueba, conversión automática a pago, cuotas gratuitas mensuales. Y no confundas esto con un plan Free de LicenRoute para
desarrolladores: son cosas distintas.

**Limitaciones conocidas** (propuesta de cambio aparte): al agotarse, el 402 ofrece el plan más antiguo de la ruta, que
podría ser el propio plan gratuito; la página pública de un plan a 0 € muestra «0.00 EUR / petición»; y no hay una
regla de «una licencia de prueba por comprador».
