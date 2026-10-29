# Agent rules — OnePageDocs (the tool itself)

To make *another* project's docs compatible, follow `docs/AI_DOCS_SETUP.md` instead of this file.

- Single-file app. Edit `src/*`, then `npm run build`. Never hand-edit `index.html`: it is generated and served by GitHub Pages.
- No runtime dependencies besides `vendor/marked.min.js`. No CDN, no network calls: the page must work from `file://` and offline.
- The app writes users' files. Every change to reading or saving must keep files byte-identical apart from the user's edit: UTF-8 BOM, CRLF/LF, and front matter as they were. Never drop unsaved edits; on conflict, ask.
- Keep UI strings in `src/i18n.js`, with both `ru` and `en`.
- Config keys: when adding one, update `DEFAULTS` in `src/app.js`, `KNOWN_KEYS` in `tools/check.mjs`, `onepage-docs.schema.json`, and the table in `docs/AI_DOCS_SETUP.md`.
- Before committing, run `npm test`; all checks must pass. If a feature is user-visible, add a check to `test/smoke.mjs` and fixture content to `test/fixture` (fictional content only, never real project docs).
- Bump `version` in `package.json` for user-visible changes.
