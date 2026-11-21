# Using LicenRoute with Claude Code or Cursor

LicenRoute ships a Claude Code **Skill** and equivalent **Cursor rules**, generated from one source, plus an approval
**hook** for each. They are plain files in this repository (`integrations/assistants/generated/en/` and `generated/es/`) and inside
the CLI package; there is no MCP server and nothing runs in the cloud.

## Install into a project

```bash
./node_modules/.bin/licenroute assistant . --claude-code     # preview of the files it would create; nothing is written
./node_modules/.bin/licenroute assistant . --claude-code --approve asst_…   # writes them after you type the challenge
./node_modules/.bin/licenroute assistant . --cursor          # same for Cursor
./node_modules/.bin/licenroute assistant . --claude-code --lang es   # the Spanish version (the code asst_… changes with the language)
```

It only creates files that do not exist and never overwrites one. For Claude Code it creates `.claude/skills/licenroute/`,
the hook `.claude/hooks/licenroute-guard.mjs` and `.claude/settings.json`; for Cursor, `.cursor/rules/licenroute.mdc`,
`.cursor/licenroute/`, `.cursor/hooks/licenroute-guard.mjs` and `.cursor/hooks.json`. If `settings.json` or `hooks.json`
already exists, it shows the merged version for you to apply by hand (it only adds LicenRoute's restrictions).

## What the assistant learns

- When LicenRoute fits (third parties paying for, or being licensed or metered on, routes of an existing Express 4 or 5
  API) and when it does not (login and roles, rate limiting without payment, DDoS, APIs still to be written, other
  frameworks). Rails is explicitly out of scope: the assistant must not propose `init` or `apply` on a Rails app, and
  the CLI refuses to write one anyway.
- The flow `init` → show you the diff → **you** approve → `dev` → `test` → `undo`, and to re-run the preview if
  anything changes.
- To report partial coverage honestly and never claim the API is fully protected when it is not.
- Never to read or print `.env*` files, keys or tokens, and never to set approval shortcuts.

## What the hook enforces

| Action | Claude Code | Cursor |
|---|---|---|
| LicenRoute writes (`init --write`, `apply --approve`, `assistant --approve`, `dev --start-app`, `undo --resolve`) | asks you | blocked (run it yourself) |
| `LICENROUTE_APPROVAL=…`, `LICENROUTE_INSECURE_TEST=…` | denied | denied |
| Reading `.env`, `.env.*`, `.env.licenroute` | denied | denied |
| Reading other processes' environment (`ps eww`, `/proc/*/environ`) | denied | denied |
| `detect`, `plan`, `init` previews, `test`, `env`, `doctor` | allowed | allowed |

Even with the hook allowing a write, the CLI still requires the one-time challenge on your terminal: an assistant
without that terminal cannot confirm. The hook matches command text, so an obfuscated command can slip past it; that
limitation is documented and tested. It also does not block `npm install licenroute` (the unscoped npm name is not this
package): install only from your verified local packages. The CLI is the real barrier.

## Language

The Skill and the rules exist in English and Spanish and state exactly the same rules (the generator checks it). They
are installed in the language you chose (`--lang`, `LICENROUTE_LANG` or your locale; English by default). The hook is one
file for both languages: it makes the same decisions and only shows its message in the installed language. The
assistant still talks to you in your language. Details: [i18n.md](i18n.md).
