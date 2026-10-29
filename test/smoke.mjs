// Smoke test: runs index.html in headless Chromium against an in-memory copy of a folder.
//   node test/smoke.mjs                 → uses test/fixture (full assertions)
//   node test/smoke.mjs <folder>        → loads any real docs folder read-only (renders, no errors)
// Needs Playwright with Chromium (npm i -D playwright && npx playwright install chromium).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = fileURLToPath(new URL(".", import.meta.url));
const custom = process.argv[2];
const dir = custom || join(here, "fixture");
const app = new URL("../index.html", import.meta.url).href;

function collect(root){
  const out = {};
  (function rec(d){
    for (const n of readdirSync(d)){
      if (n === ".git" || n === "node_modules") continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) rec(p);
      else if (/\.(md|markdown|json)$/i.test(n)) out[relative(root, p).split(sep).join("/")] = readFileSync(p, "latin1");
    }
  })(root);
  return out;
}
const files = collect(dir);

// In-page fake of the File System Access API backed by window.__fs (strings hold raw bytes).
const MOCK = `
window.__fs = ${JSON.stringify(files)}; window.__writes = {}; window.__mod = {};
const bytes = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
function fileH(path){ const name = path.split('/').pop(); return { kind:'file', name, __p:path,
  async getFile(){ return new File([bytes(window.__fs[path])], name, { lastModified: window.__mod[path] || 1 }); },
  async createWritable(){ let buf = ''; return { async write(s){ buf += unescape(encodeURIComponent(s)); }, async close(){ window.__fs[path] = buf; window.__writes[path] = buf; window.__mod[path] = (window.__mod[path] || 1) + 1; } }; },
  async isSameEntry(o){ return !!o && o.__p === path; } }; }
function dirH(prefix, name){ return { kind:'directory', name, __p:prefix,
  async *entries(){ const seen = new Set(); for (const p of Object.keys(window.__fs)){ if (!p.startsWith(prefix)) continue; const rest = p.slice(prefix.length); const i = rest.indexOf('/');
    if (i < 0) yield [rest, fileH(p)]; else { const d = rest.slice(0, i); if (!seen.has(d)){ seen.add(d); yield [d, dirH(prefix + d + '/', d)]; } } } },
  async getDirectoryHandle(n){ if (Object.keys(window.__fs).some(p => p.startsWith(prefix + n + '/'))) return dirH(prefix + n + '/', n); throw new DOMException('no', 'NotFoundError'); },
  async getFileHandle(n){ if ((prefix + n) in window.__fs) return fileH(prefix + n); throw new DOMException('no', 'NotFoundError'); },
  async queryPermission(){ return 'granted'; }, async requestPermission(){ return 'granted'; },
  async isSameEntry(o){ return !!o && o.__p === prefix; } }; }
window.showDirectoryPicker = async () => dirH('', 'sample-repo');
`;

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) failed++; };
const utf8 = s => Buffer.from(s, "latin1").toString("utf8");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, locale: "en-US" });
await ctx.addInitScript(MOCK);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(app);
await page.click("#btnOpen");
await page.waitForSelector("section.file");
const mdCount = Object.keys(files).filter(p => /\.(md|markdown)$/i.test(p)).length;
ok(await page.locator("section.file").count() === mdCount, `renders all ${mdCount} markdown files`);

if (!custom){
  const order = await page.$$eval("section .fpath", e => e.map(x => x.textContent));
  ok(order[0] === "docs/00 Start.md", "pinned file comes first");
  ok(order.indexOf("docs/INDEX.md") > order.indexOf("docs/Questions.md"), "'last' file goes after its group");
  ok(order[order.length - 1] === "README.md", "files outside docsRoot go last");
  ok((await page.textContent("#brand")).startsWith("Sample Game"), "title from onepage-docs.json");
  ok(await page.locator(".gen").count() === 1, "generated marker flagged");
  ok(await page.locator(".prop b", { hasText: "project" }).count() === 0, "hideProps works");
  ok(await page.locator(".prop b", { hasText: "depends on" }).count() === 1, "propLabels works");
  ok(await page.locator(".chip.warn", { hasText: "Partially defined" }).count() === 1, "status chip colouring");

  const s01 = page.locator("section.file", { has: page.locator(".fpath", { hasText: "S01" }) });
  await s01.locator(".body input[type=checkbox]").nth(2).check();
  await page.waitForTimeout(1300);
  const w = await page.evaluate(() => window.__writes["docs/Systems/S01 Movement.md"]);
  ok(w && w.includes("- [x] Jump\r\n") && w.includes("```\r\n- [ ] not a task"), "checkbox toggles the right line, CRLF kept, fenced code untouched");

  const t01 = page.locator("section.file", { has: page.locator(".fpath", { hasText: "T01" }) });
  await t01.locator(".fedit").click();
  await t01.locator("textarea").press("End");
  await t01.locator("textarea").type("\nНовая строка");
  await page.waitForTimeout(1300);
  const w2 = await page.evaluate(() => window.__writes["docs/Tasks/T01 Prototype movement.md"]);
  ok(w2 && w2.startsWith("\xef\xbb\xbf---") && utf8(w2).includes("Новая строка"), "text edit saved as UTF-8, BOM kept");
  await t01.locator("textarea").press("Escape");

  await s01.locator("a.wl", { hasText: "Q2" }).click();
  await page.waitForTimeout(200);
  const q2Top = await page.evaluate(() => [...document.querySelectorAll("h2")].find(h => h.textContent === "Q2").getBoundingClientRect().top);
  ok(q2Top > 40 && q2Top < 160, "[[Note#Heading]] scrolls to the heading");
  ok(await page.locator("a.wl.missing", { hasText: "System map.canvas" }).count() === 1, "missing targets marked");
  const readme = page.locator("section.file", { has: page.locator(".fpath", { hasText: "README" }) });
  ok(await readme.locator("a.wl.missing").count() === 0, "relative .md links resolve");

  await page.fill("#q", "carry");
  await page.waitForTimeout(500);
  ok(await page.locator("section.file:not(.hide)").count() === 1 && await page.locator("mark").count() >= 1, "search filters and highlights");
  await page.fill("#q", "");
  await page.waitForTimeout(400);

  // position cache: scroll to S01, reload, reopen the same folder → lands on S01
  await page.locator("aside a", { hasText: "S01 Movement" }).click();
  await page.waitForTimeout(800);
  await page.evaluate(() => { history.replaceState(null, "", location.pathname); });
  await page.reload();
  await page.click("#btnOpen");
  await page.waitForSelector("section.file");
  await page.waitForFunction(() => document.querySelector("aside a.active"), null, { timeout: 3000 }).catch(() => {});
  const active = await page.textContent("aside a.active");
  ok(active && active.includes("S01 Movement"), "reopening the folder returns to the last document");
} else {
  await page.screenshot({ path: "smoke-custom.png" });
  console.log("  screenshot: smoke-custom.png");
}
ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
