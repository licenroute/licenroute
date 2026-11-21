# Removing LicenRoute from a project

1. Stop demo mode if it is running: `./node_modules/.bin/licenroute dev . --stop`.
2. Revert the integration exactly: `./node_modules/.bin/licenroute undo .`
   - It restores every file LicenRoute wrote, byte for byte, and deletes its journal (`.licenroute/journal/`).
   - It never overwrites a file you changed afterwards: it stops and tells you which one.
   - It lists what it did not remove, for you to decide.
3. Remove what is left, if you no longer want it:

```bash
rm -f .env.licenroute                 # synthetic demo credentials
rm -rf .licenroute                    # demo state (empty after undo and dev --stop)
npm uninstall --ignore-scripts @licenroute/connect-express
npm uninstall --ignore-scripts @licenroute/cli
```

4. If you installed the assistant files: remove `.claude/skills/licenroute/`, `.claude/hooks/licenroute-guard.mjs` and the
   LicenRoute entries in `.claude/settings.json` (Claude Code), or `.cursor/rules/licenroute.mdc`, `.cursor/licenroute/`,
   `.cursor/hooks/licenroute-guard.mjs` and the LicenRoute entry in `.cursor/hooks.json` (Cursor). `undo` reports them but
   does not delete them, because they are not part of the integration.

To reinstall later, use `npm install --ignore-scripts <tarball>` again and start from `./node_modules/.bin/licenroute init .`.
