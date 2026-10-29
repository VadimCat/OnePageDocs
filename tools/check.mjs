#!/usr/bin/env node
// OnePageDocs compatibility check for a docs folder. No dependencies.
//   node tools/check.mjs <repo-or-docs-folder> [--json]
// Exit code 1 when there are errors (things that will render or save wrong), 0 otherwise.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, posix } from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const root = args.find(a => !a.startsWith("--")) || ".";
if (!existsSync(root) || !statSync(root).isDirectory()){ console.error(`Not a folder: ${root}`); process.exit(2); }

const DEFAULT_SKIP = ["node_modules", "worktrees", "Library", "Temp", "Logs", "obj", "bin", "Build", "Builds", "dist", "__pycache__", "venv"];
const KNOWN_KEYS = ["title", "subtitle", "language", "docsRoot", "includeOutside", "groups", "pin", "last", "skip", "generatedMarker", "hideProps", "propLabels", "status", "maxFiles", "$schema", "_comment"];
const issues = [];
const add = (level, file, msg) => issues.push({ level, file, msg });
const asList = v => v == null ? [] : Array.isArray(v) ? v : [v];
const stem = p => posix.basename(p).replace(/\.(md|markdown)$/i, "");
const slug = s => String(s).toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

// --- config
let cfg = {}, cfgName = null;
for (const n of ["onepage-docs.json", ".onepage-docs.json"]){
  const p = join(root, n);
  if (!existsSync(p)) continue;
  cfgName = n;
  try{ cfg = JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")); }
  catch(e){ add("error", n, `invalid JSON: ${e.message}`); }
  break;
}
if (!cfgName) add("info", "-", "no onepage-docs.json — defaults are used (fine, but groups/labels/pins are guessed)");
for (const k of Object.keys(cfg)) if (!KNOWN_KEYS.includes(k)) add("warn", cfgName, `unknown key "${k}"`);
let docsRoot = cfg.docsRoot ?? "auto";
if (docsRoot === "auto") docsRoot = existsSync(join(root, "docs")) && statSync(join(root, "docs")).isDirectory() ? "docs" : "";
docsRoot = String(docsRoot).replace(/^\/+|\/+$/g, "");
if (docsRoot && !existsSync(join(root, docsRoot))) add("error", cfgName, `docsRoot "${docsRoot}" does not exist`);
for (const g of asList(cfg.groups)){
  const gp = typeof g === "string" ? g : g.path || "";
  if (gp.includes("/")) add("warn", cfgName, `group "${gp}": only the first folder level becomes a group`);
  if (gp && !existsSync(join(root, docsRoot, gp))) add("warn", cfgName, `group folder "${gp}" not found under "${docsRoot || "."}"`);
}
for (const k of ["bad", "warn", "ok"]) for (const re of asList(cfg.status && cfg.status[k])){ try{ new RegExp(re, "iu"); }catch(e){ add("error", cfgName, `status.${k}: bad regex ${re}`); } }

// --- files
const skip = new Set([...DEFAULT_SKIP, ...asList(cfg.skip)]);
const md = [], other = new Set();
(function walk(d, depth){
  for (const n of readdirSync(d)){
    const p = join(d, n);
    let st; try{ st = statSync(p); }catch(e){ continue; }
    if (st.isDirectory()){ if (!n.startsWith(".") && !skip.has(n) && depth <= 8) walk(p, depth + 1); continue; }
    const rel = relative(root, p).split(sep).join("/");
    if (cfg.includeOutside === false && docsRoot && !rel.startsWith(docsRoot + "/")) continue;
    if (/\.(md|markdown)$/i.test(n)) md.push({ rel, size: st.size }); else other.add(n.toLowerCase());
  }
})(root, 0);
if (!md.length) add("error", "-", "no .md files found");

const byStem = new Map();
for (const f of md){ const k = stem(f.rel).toLowerCase(); if (!byStem.has(k)) byStem.set(k, []); byStem.get(k).push(f.rel); }
for (const [k, list] of byStem) if (list.length > 1) add("warn", list.join(", "), `same file name "${k}" — [[${k}]] opens the first one only; rename or link by path`);

const byPath = new Set(md.map(f => f.rel.toLowerCase()));
const headings = new Map();
const texts = new Map();
for (const f of md){
  const buf = readFileSync(join(root, f.rel));
  let text = buf.toString("utf8");
  if (text.includes("�")) add("error", f.rel, "not valid UTF-8 — will be corrupted on save; re-save as UTF-8");
  if (f.size > 1024 * 1024) add("warn", f.rel, `large file (${(f.size / 1048576).toFixed(1)} MB) — slow to render`);
  text = text.replace(/^﻿/, "");
  const crlf = text.includes("\r\n"), lf = /(^|[^\r])\n/.test(text);
  if (crlf && lf) add("warn", f.rel, "mixed CRLF and LF line endings — saving normalises them to CRLF");
  text = text.replace(/\r\n/g, "\n");
  texts.set(f.rel, text);
  const fm = text.match(/^---\n([\s\S]*?)\n---[ \t]*(\n|$)/);
  if (text.startsWith("---\n") && !fm) add("error", f.rel, "front matter opened with --- but never closed");
  if (fm){
    fm[1].split("\n").forEach((line, i) => {
      if (/^\s+[^\s-][^:]*:\s/.test(line)) add("warn", f.rel, `front matter line ${i + 2}: nested keys are shown flattened — keep properties one level deep`);
      if (/:\s*[|>][-+]?\s*$/.test(line)) add("warn", f.rel, `front matter line ${i + 2}: multi-line strings (| or >) are not shown as properties`);
    });
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const hs = []; let fence = false;
  for (const l of body.split("\n")){
    if (/^\s*(```|~~~)/.test(l)){ fence = !fence; continue; }
    const m = !fence && l.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (m) hs.push(m[1].replace(/[*_`]/g, "").trim());
  }
  headings.set(f.rel, hs);
}
const findStem = name => { const n = name.toLowerCase().replace(/\.(md|markdown)$/i, ""); return (byStem.get(n) || byStem.get(n.split("/").pop()) || [])[0] || (byPath.has(n + ".md") ? md.find(f => f.rel.toLowerCase() === n + ".md").rel : null); };
const hasHeading = (rel, frag) => { const fl = frag.toLowerCase().trim(), fs = slug(frag); return (headings.get(rel) || []).some(h => h.toLowerCase() === fl || slug(h) === fs || h.toLowerCase().startsWith(fl)); };
for (const [rel, text] of texts){
  const plain = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g).filter((_, i) => i % 2 === 0).join("\n");
  for (const m of plain.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)){
    if (m[1]) continue; // embeds are shown as a placeholder
    const [target] = m[2].replace(/\\\|/g, "|").split("|");
    const [name, frag] = target.split("#");
    if (!name){ if (frag && !hasHeading(rel, frag)) add("warn", rel, `[[#${frag}]]: heading not found`); continue; }
    if (/\.\w+$/.test(name) && !/\.(md|markdown)$/i.test(name)){ if (!other.has(posix.basename(name).toLowerCase())) add("warn", rel, `[[${name}]]: file not found`); continue; }
    const tgt = findStem(name);
    if (!tgt) add("warn", rel, `[[${name}]]: no such document`);
    else if (frag && !hasHeading(tgt, frag)) add("warn", rel, `[[${name}#${frag}]]: heading not found in ${tgt}`);
  }
  for (const m of plain.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)){
    let href = m[1];
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) continue;
    let [p] = href.split("#");
    try{ p = decodeURIComponent(p); }catch(e){}
    if (!/\.(md|markdown)$/i.test(p)) continue;
    const full = posix.normalize(posix.join(posix.dirname(rel), p));
    if (!byPath.has(full.toLowerCase())) add("warn", rel, `link ${href}: target not found (${full})`);
  }
}

// --- report
const order = { error: 0, warn: 1, info: 2 };
issues.sort((a, b) => order[a.level] - order[b.level]);
const counts = { error: 0, warn: 0, info: 0 };
issues.forEach(i => counts[i.level]++);
if (asJson){ console.log(JSON.stringify({ root, docsRoot, files: md.length, config: cfgName, counts, issues }, null, 2)); }
else {
  console.log(`OnePageDocs check: ${md.length} markdown files, docsRoot="${docsRoot}", config=${cfgName || "none"}`);
  for (const i of issues) console.log(`${i.level.toUpperCase().padEnd(5)} ${i.file}: ${i.msg}`);
  console.log(`\n${counts.error} error(s), ${counts.warn} warning(s)` + (counts.error ? "" : " — compatible"));
}
process.exit(counts.error ? 1 : 0);
