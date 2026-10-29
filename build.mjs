// Builds the single-file app: src/* + vendor/marked → index.html (open it directly or via GitHub Pages).
import { readFileSync, writeFileSync } from "node:fs";
const read = p => readFileSync(new URL(p, import.meta.url), "utf8");
const safe = s => s.replace(/<\/script/gi, "<\\/script");
const { version } = JSON.parse(read("./package.json"));
// Function replacers: the inlined code contains `$&`-like sequences that string replacement would mangle.
const html = read("./src/index.html")
  .replace("/*@STYLE@*/", () => read("./src/style.css"))
  .replace("/*@MARKED@*/", () => safe(read("./vendor/marked.min.js")))
  .replace("/*@APP@*/", () => safe(read("./src/i18n.js") + "\n" + read("./src/app.js")))
  .replaceAll("@VERSION@", version);
writeFileSync(new URL("./index.html", import.meta.url), html);
console.log(`index.html built (v${version}, ${(html.length / 1024).toFixed(0)} KB)`);
