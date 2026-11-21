# Quitar LicenRoute de un proyecto

1. Para el modo demo si está en marcha: `./node_modules/.bin/licenroute dev . --stop`.
2. Revierte la integración exactamente: `./node_modules/.bin/licenroute undo .`
   - Restaura byte a byte cada fichero que escribió LicenRoute y borra su diario (`.licenroute/journal/`).
   - Nunca sobrescribe un fichero que cambiaste después: se para y te dice cuál.
   - Enumera lo que no quitó, para que decidas tú.
3. Quita lo que queda, si ya no lo quieres:

```bash
rm -f .env.licenroute                 # credenciales sintéticas de demo
rm -rf .licenroute                    # estado de la demo (vacío tras undo y dev --stop)
npm uninstall --ignore-scripts @licenroute/connect-express
npm uninstall --ignore-scripts @licenroute/cli
```

4. Si instalaste los ficheros del asistente: quita `.claude/skills/licenroute/`, `.claude/hooks/licenroute-guard.mjs` y las
   entradas de LicenRoute de `.claude/settings.json` (Claude Code), o `.cursor/rules/licenroute.mdc`, `.cursor/licenroute/`,
   `.cursor/hooks/licenroute-guard.mjs` y la entrada de LicenRoute de `.cursor/hooks.json` (Cursor). `undo` los menciona pero
   no los borra, porque no forman parte de la integración.

Para volver a instalarlo, usa otra vez `npm install --ignore-scripts <tarball>` y empieza por `./node_modules/.bin/licenroute init .`.
