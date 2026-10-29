# OnePageDocs

All the Markdown docs in a folder as one document you can edit in place. Edits are written straight back to the `.md` files on disk, so Obsidian, git and AI agents see them immediately: no export, no sync. Nothing to install and no server to run: it is a single HTML page.

**Open:** https://vadimcat.github.io/OnePageDocs/ (Edge or Chrome) or `index.html` from this repo.

English · **[Русский](README.ru.md)**

## Contents

- [Features](#features)
- [Run locally (offline, no server)](#run-locally-offline-no-server)
- [Use it with your project](#use-it-with-your-project)
- [Limitations](#limitations)
- [Development](#development)
- [Guide for AI agents: making docs compatible](docs/AI_DOCS_SETUP.md)
- [Rules for agents working on the tool itself](AGENTS.md)

## Features

- Every `.md` file in one continuous page, a sidebar grouped by folder, full-text search with highlighting.
- Editing: double-click the text or press ✎, or switch everything to edit mode with "Edit all". Autosaves after a second; `Ctrl+S` saves everything at once.
- `- [ ]` checkboxes can be ticked right in the rendered view and are written to the file.
- `[[wikilinks]]`, `[[Note#Heading]]`, relative `.md` links and images work inside the page.
- Front matter properties are shown as chips, with status values colour-coded.
- If a file changes on disk while you are editing it (Obsidian, `git pull`), the editor asks which version to keep.
- Encoding, BOM and line endings (CRLF/LF) are preserved exactly.
- Remembers your folders and where you stopped: next time the page scrolls straight to the last document. A link with `#path/to/file.md` opens a specific document.
- `Ctrl+P` prints the whole page or saves it as PDF.
- English and Russian UI, light and dark theme.

## Run locally (offline, no server)

The whole editor is one file, `index.html`, with everything inlined. No Node, no server.

1. Get `index.html` in one of these ways:
   - open [index.html](index.html) on GitHub and press **Download raw file**;
   - or get the whole repo: `git clone https://github.com/VadimCat/OnePageDocs` (or **Code → Download ZIP**).
2. Open the file in **Edge or Chrome**: double-click it (if your default browser is Chromium-based), drag it into a browser window, or run [launchers/OnePageDocs.bat](launchers/OnePageDocs.bat) from the clone (opens it in Edge).
3. Press **"Choose folder…"**, pick the root of the repo with your docs and allow editing.

You can keep the file anywhere, for example right inside your project repo next to the docs. To update, download `index.html` again or `git pull`.

The hosted page and a local file live at different addresses, so each remembers its own recent folders and last position.

## Use it with your project

1. Open the page and choose the **repo root**. A `docs` folder is picked up automatically.
2. Optionally add `onepage-docs.json` to the root: title, group order and labels, pinned documents, generated files and more. Example: [examples/onepage-docs.json](examples/onepage-docs.json). All fields: [docs/AI_DOCS_SETUP.md](docs/AI_DOCS_SETUP.md#3-конфиг-onepage-docsjson), [schema](onepage-docs.schema.json).
3. Check compatibility:
   ```bash
   curl -sL https://raw.githubusercontent.com/VadimCat/OnePageDocs/main/tools/check.mjs | node - path/to/repo
   ```

If an agent prepares the docs, give it [docs/AI_DOCS_SETUP.md](docs/AI_DOCS_SETUP.md): rules, config and a step-by-step workflow.

On Windows, [launchers/OnePageDocs.bat](launchers/OnePageDocs.bat) opens the editor in Edge; drop it next to your project.

## Limitations

- Needs a Chromium browser (Edge, Chrome, Opera, Brave): only they can write to folders. Firefox and Safari can't open a folder.
- Obsidian `.canvas`, `.base` and `![[...]]` embeds are not rendered; a placeholder is shown instead.
- Front matter is read flat: `key: value` and lists.
- Files are not created, renamed or deleted. Do that in Obsidian or your file manager, then press "↻ Reload".

## Development

```
src/index.html   page template
src/style.css    styles (light and dark theme)
src/i18n.js      UI strings, ru/en
src/app.js       logic
vendor/          marked (MIT)
build.mjs        bundles everything into a single index.html
tools/check.mjs  docs compatibility checker
test/smoke.mjs   smoke test in headless Chromium against test/fixture
```

```bash
npm run build                       # src → index.html
npm test                            # build + smoke test (needs playwright with chromium)
node test/smoke.mjs path/to/docs    # run against a real folder (read-only)
```

`index.html` is a build output and is also what GitHub Pages serves. Edit `src/` and rebuild. Rules for agents working on the tool itself: [AGENTS.md](AGENTS.md).

MIT licensed.
