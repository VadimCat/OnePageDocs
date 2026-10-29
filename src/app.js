"use strict";
/*
 * OnePageDocs — every Markdown file of a folder as one editable page.
 * Reads and writes the files directly through the File System Access API (Edge / Chrome).
 * Optional per-project config: onepage-docs.json in the chosen folder (see docs/AI_DOCS_SETUP.md).
 */
const $ = s => document.querySelector(s);
const CONFIG_FILES = ["onepage-docs.json", ".onepage-docs.json"];
const DEFAULT_SKIP = ["node_modules", "worktrees", "Library", "Temp", "Logs", "obj", "bin", "Build", "Builds", "dist", "__pycache__", "venv"];
const DEFAULT_STATUS = {
  bad:  ["^не ", "^нет", "отсутств", "^открыт", "^not ", "^no ", "^none", "missing", "^open", "blocked", "заблок"],
  warn: ["частич", "в работе", "предлож", "черновик", "partial", "in progress", "draft", "proposed", "wip", "review"],
  ok:   ["^готов", "^принят", "^проверен", "^утвержд", "^сделан", "^закрыт", "^определён", "^done", "^ready", "^accepted", "^approved", "^verified", "^closed", "^complete"],
};
const DEFAULTS = {
  title: null, subtitle: "", language: null,
  docsRoot: "auto", includeOutside: true,
  groups: [], pin: [], last: [], skip: [],
  generatedMarker: [], hideProps: [], propLabels: {}, status: null,
  maxFiles: 1500,
};

const S = { root: null, cfg: { ...DEFAULTS }, files: [], editAll: false, hidden: new Set(), q: "", active: null, docsRoot: "" };

/* ---------- small helpers ---------- */
function lsGet(k, d){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }catch(e){ return d; } }
function lsSet(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const stem = p => p.split("/").pop().replace(/\.(md|markdown)$/i, "");
const slug = s => String(s).toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
const asList = v => v == null ? [] : Array.isArray(v) ? v : [v];
let toastT;
function toast(msg){ const el = $("#toast"); el.textContent = msg; el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2800); }
const stateKey = () => "opd:state:" + (S.root ? S.root.name : "");
function getState(){ return lsGet(stateKey(), {}); }
function putState(patch){ lsSet(stateKey(), { ...getState(), ...patch }); }

/* ---------- IndexedDB: remember folders ---------- */
function idb(){ return new Promise((res, rej) => { const r = indexedDB.open("onepage-docs", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function kvSet(k, v){ try{ const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }catch(e){} }
async function kvGet(k){ try{ const db = await idb(); return await new Promise((res, rej) => { const r = db.transaction("kv").objectStore("kv").get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }catch(e){ return null; } }
async function rememberFolder(h){
  let list = (await kvGet("recent")) || [];
  const keep = [];
  for (const r of list){ try{ if (!(await r.handle.isSameEntry(h))) keep.push(r); }catch(e){ keep.push(r); } }
  keep.unshift({ handle: h, name: h.name, at: Date.now() });
  await kvSet("recent", keep.slice(0, 6));
}

/* ---------- config ---------- */
async function readConfig(root){
  for (const name of CONFIG_FILES){
    let fh; try{ fh = await root.getFileHandle(name); }catch(e){ continue; }
    try{
      const raw = await (await fh.getFile()).text();
      return { ...DEFAULTS, ...JSON.parse(raw.replace(/^﻿/, "")), _file: name };
    }catch(e){ toast(t("configErr", { file: name, m: e.message })); return { ...DEFAULTS, _file: name }; }
  }
  return { ...DEFAULTS };
}
function statusRules(){
  const src = S.cfg.status || DEFAULT_STATUS;
  const out = [];
  for (const cls of ["bad", "warn", "ok"]) for (const re of asList(src[cls])) { try{ out.push([cls, new RegExp(re, "iu")]); }catch(e){} }
  return out;
}

/* ---------- loading ---------- */
async function dirAt(root, rel){
  let d = root;
  for (const seg of rel.split("/").filter(Boolean)) d = await d.getDirectoryHandle(seg);
  return d;
}
async function walk(dir, prefix, out, depth, skip){
  for await (const [name, h] of dir.entries()){
    if (out.length >= S.cfg.maxFiles){ S.truncated = true; return; }
    if (h.kind === "directory"){
      if (name.startsWith(".") || skip.has(name) || depth > 8) continue;
      await walk(h, prefix + name + "/", out, depth + 1, skip);
    } else if (/\.(md|markdown)$/i.test(name)) out.push({ path: prefix + name, handle: h });
  }
}
function matchesList(f, list){
  const s = stem(f.path).toLowerCase(), r = f.rel.toLowerCase(), p = f.path.toLowerCase();
  return asList(list).findIndex(x => { x = String(x).toLowerCase().replace(/\.(md|markdown)$/i, ""); return x === s || x + ".md" === r || x + ".md" === p; });
}
function classify(list){
  const dr = S.docsRoot;
  for (const f of list){
    if (dr && !f.path.startsWith(dr + "/")){ f.rel = f.path; f.group = "@outside"; continue; }
    f.rel = dr ? f.path.slice(dr.length + 1) : f.path;
    f.group = f.rel.includes("/") ? f.rel.split("/")[0] : "";
  }
  const cfgGroups = asList(S.cfg.groups).map(g => typeof g === "string" ? { path: g } : g);
  const gIndex = g => { if (g === "@outside") return 1e6; const i = cfgGroups.findIndex(x => (x.path || "") === g); return i >= 0 ? i : g === "" ? -1 : 1000; };
  S.groupLabel = g => { const c = cfgGroups.find(x => (x.path || "") === g); return c && c.label ? c.label : g === "" ? t("groupRoot") : g === "@outside" ? t("groupOutside") : g; };
  S.groupDefaultHidden = cfgGroups.filter(x => x.hidden).map(x => x.path || "");
  const defaultPin = f => /^(0+[\s_.-]|readme$)/i.test(stem(f.path)) ? 0 : 1;
  const pinRank = f => { const i = matchesList(f, S.cfg.pin); return i >= 0 ? i - 1e4 : asList(S.cfg.pin).length ? 0 : defaultPin(f) - 1; };
  const lastRank = f => { const i = matchesList(f, S.cfg.last); return i >= 0 ? 1 + i : 0; };
  list.sort((a, b) => gIndex(a.group) - gIndex(b.group) || a.group.localeCompare(b.group)
    || lastRank(a) - lastRank(b) || pinRank(a) - pinRank(b)
    || stem(a.path).localeCompare(stem(b.path), undefined, { numeric: true, sensitivity: "base" }));
}
// Blob.text() silently drops a UTF-8 BOM, so decode by hand to keep files byte-identical.
const DEC = new TextDecoder("utf-8", { ignoreBOM: true });
async function rawText(file){ return DEC.decode(await file.arrayBuffer()); }
async function readFile(f){
  const file = await f.handle.getFile();
  const raw = await rawText(file);
  f.bom = raw.charCodeAt(0) === 0xFEFF;
  const body = f.bom ? raw.slice(1) : raw;
  f.crlf = body.includes("\r\n");
  f.text = f.crlf ? body.replace(/\r\n/g, "\n") : body;
  f.diskText = raw; f.diskMod = file.lastModified;
}
async function load(root, opts = {}){
  S.root = root;
  S.cfg = await readConfig(root);
  setLang(S.cfg.language); applyLabels();
  let dr = S.cfg.docsRoot;
  if (dr === "auto"){ dr = ""; try{ await root.getDirectoryHandle("docs"); dr = "docs"; }catch(e){} }
  S.docsRoot = String(dr || "").replace(/^\/+|\/+$/g, "");
  const skip = new Set([...DEFAULT_SKIP, ...asList(S.cfg.skip)]);
  const list = []; S.truncated = false;
  if (S.docsRoot && S.cfg.includeOutside === false){
    let d; try{ d = await dirAt(root, S.docsRoot); }catch(e){ toast(t("configErr", { file: S.cfg._file || "config", m: "docsRoot not found" })); d = root; S.docsRoot = ""; }
    await walk(d, S.docsRoot ? S.docsRoot + "/" : "", list, 0, skip);
  } else await walk(root, "", list, 0, skip);
  if (!list.length){ toast(t("noMd")); return; }
  classify(list);
  await Promise.all(list.map(readFile));
  list.forEach((f, i) => { f.id = "f" + i; f.mode = S.editAll ? "edit" : "view"; f.dirty = false; f.saving = null; });
  S.files = list;
  S.byName = new Map(); S.byPath = new Map();
  for (const f of list){
    const k = stem(f.path).toLowerCase(); if (!S.byName.has(k)) S.byName.set(k, f);
    S.byPath.set(f.path.toLowerCase(), f); S.byPath.set(f.rel.toLowerCase(), f);
  }
  const st = getState();
  S.hidden = new Set(st.hidden || S.groupDefaultHidden);
  build();
  for (const b of ["#q", "#btnEditAll", "#btnRefresh"]) $(b).disabled = false;
  $("#btnOpen").textContent = t("openOther");
  const title = S.cfg.title || root.name;
  $("#brand").innerHTML = esc(title) + (S.cfg.subtitle ? `<span>${esc(S.cfg.subtitle)}</span>` : "");
  document.title = title + (S.cfg.subtitle ? " " + S.cfg.subtitle : "");
  restorePosition(opts.keepScroll);
  updateGlobal();
  if (S.truncated) toast(t("tooMany", { n: list.length }));
  rememberFolder(root);
}
async function pickFolder(){
  try{
    const h = await window.showDirectoryPicker({ id: "onepage-docs", mode: "readwrite" });
    if (S.files.length && (await flushAll()) === false) return;
    await load(h);
  }catch(e){ if (e.name !== "AbortError") toast(t("openFail", { m: e.message })); }
}
async function openRemembered(h){
  try{
    let p = await h.queryPermission({ mode: "readwrite" });
    if (p !== "granted") p = await h.requestPermission({ mode: "readwrite" });
    if (p === "granted") await load(h); else toast(t("folderGone"));
  }catch(e){ toast(t("folderGone")); }
}

/* ---------- position cache ---------- */
function restorePosition(keepScroll){
  const scroller = $("#doc");
  if (keepScroll != null){ scroller.scrollTop = keepScroll; onScroll(); return; }
  let target = null, offset = 0, fromHash = false;
  const h = decodeURIComponent(location.hash.slice(1) || "");
  if (h) { target = S.byPath.get(h.toLowerCase()); fromHash = !!target; }
  const st = getState();
  if (!target && st.path) target = S.byPath.get(String(st.path).toLowerCase());
  if (target && st.path && target.path === st.path) offset = st.offset || 0;
  if (!target){ scroller.scrollTop = 0; onScroll(); return; }
  if (target.el.classList.contains("hide")) { S.hidden.delete(target.group); build(); target = S.files.find(x => x.path === target.path); }
  scroller.scrollTop = Math.max(0, target.el.offsetTop + offset);
  onScroll();
  if (!fromHash && target !== S.files[0]) toast(t("restored", { doc: stem(target.path) }));
}
let saveT;
function savePosition(){
  if (!S.active) return;
  const offset = Math.round($("#doc").scrollTop - S.active.el.offsetTop);
  putState({ path: S.active.path, offset, at: Date.now(), hidden: [...S.hidden] });
}
let scrollRaf = 0;
function onScroll(){
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const top = $("#doc").scrollTop + 40;
    let act = null;
    for (const f of S.files){ if (f.el.classList.contains("hide")) continue; if (f.el.offsetTop <= top) act = f; else break; }
    if (!act) act = S.files.find(f => !f.el.classList.contains("hide")) || null;
    if (act !== S.active){
      if (S.active) S.active.nav.classList.remove("active");
      S.active = act;
      if (act){
        act.nav.classList.add("active"); act.nav.scrollIntoView({ block: "nearest" });
        try{ history.replaceState(null, "", "#" + encodeURIComponent(act.path)); }catch(e){}
      }
    }
    clearTimeout(saveT); saveT = setTimeout(savePosition, 300);
  });
}
$("#doc").addEventListener("scroll", onScroll, { passive: true });

/* ---------- building the page ---------- */
function build(){
  const side = $("#side"), doc = $("#doc");
  side.innerHTML = ""; doc.innerHTML = ""; S.active = null;
  const groups = new Map();
  for (const f of S.files){ if (!groups.has(f.group)) groups.set(f.group, []); groups.get(f.group).push(f); }
  for (const [g, fs] of groups){
    const box = document.createElement("div"); box.className = "grp" + (S.hidden.has(g) ? " off" : "");
    box.innerHTML = `<div class="ghead" title="${esc(t("groupTip"))}"><span>${esc(S.groupLabel(g))}</span><span class="n">${fs.length}</span><button class="eye">${S.hidden.has(g) ? "◌" : "●"}</button></div><div class="gitems"></div>`;
    const items = box.querySelector(".gitems");
    box.querySelector(".ghead").onclick = () => {
      if (S.hidden.has(g)) S.hidden.delete(g); else S.hidden.add(g);
      box.classList.toggle("off", S.hidden.has(g)); box.querySelector(".eye").textContent = S.hidden.has(g) ? "◌" : "●";
      putState({ hidden: [...S.hidden] }); applyFilter();
    };
    for (const f of fs){
      const a = document.createElement("a"); a.href = "#" + encodeURIComponent(f.path); a.title = f.path;
      a.innerHTML = `<span class="dot"></span><span>${esc(stem(f.path))}</span>`;
      a.onclick = e => { e.preventDefault(); reveal(f); };
      f.nav = a; items.appendChild(a);
    }
    side.appendChild(box);
  }
  const markers = asList(S.cfg.generatedMarker);
  for (const f of S.files){
    const sec = document.createElement("section"); sec.className = "file"; sec.id = f.id; f.el = sec;
    const isGen = /^generated:\s*true\s*$/m.test(f.text.split(/\n---/)[0]) || markers.some(m => m && f.text.includes(m));
    const gen = isGen ? `<span class="gen" title="${esc(t("generatedTip"))}">${esc(t("generated"))}</span>` : "";
    sec.innerHTML = `<div class="fhead"><span class="fpath">${esc(f.path)}</span>${gen}<span class="fstat"></span><button class="fedit"></button></div><div class="fwrap"></div>`;
    sec.querySelector(".fedit").onclick = () => setMode(f, f.mode === "edit" ? "view" : "edit", true);
    doc.appendChild(sec); render(f); setStat(f);
  }
  applyFilter();
}
function render(f){
  const wrap = f.el.querySelector(".fwrap");
  f.el.classList.toggle("editing", f.mode === "edit");
  f.el.querySelector(".fedit").textContent = f.mode === "edit" ? t("editDone") : t("edit");
  if (f.mode === "edit"){
    wrap.innerHTML = `<textarea class="src" spellcheck="true"></textarea><div class="hint">${esc(t("editHint"))}</div>`;
    const ta = wrap.querySelector("textarea"); ta.value = f.text; f.ta = ta;
    ta.addEventListener("input", () => { f.text = ta.value; autosize(ta); touch(f); });
    ta.addEventListener("keydown", e => {
      if (e.key === "Escape" && !S.editAll){ e.preventDefault(); setMode(f, "view"); }
      if (e.key === "Tab" && !e.shiftKey){ e.preventDefault(); ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input")); }
    });
    requestAnimationFrame(() => autosize(ta));
    return;
  }
  f.ta = null;
  const { props, body, off } = splitFM(f.text);
  f.bodyOff = off;
  let html = props && props.length ? `<div class="props">${props.map(renderProp).join("")}</div>` : "";
  html += `<div class="body">${marked.parse(wikify(body), { gfm: true })}</div>`;
  wrap.innerHTML = html;
  postProcess(f, wrap);
  if (S.q) highlight(wrap, S.q);
}
function autosize(ta){ ta.style.height = "auto"; ta.style.height = (ta.scrollHeight + 4) + "px"; }
function setMode(f, mode, focus){
  if (f.mode === mode) return;
  const scroller = $("#doc"), top = f.el.getBoundingClientRect().top;
  f.mode = mode; render(f);
  const d = f.el.getBoundingClientRect().top - top; if (d) scroller.scrollTop += d;
  if (mode === "edit" && focus && f.ta) f.ta.focus({ preventScroll: true });
}

/* ---------- Markdown helpers ---------- */
function unq(s){ s = s.trim(); if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1).replace(/''/g, "'"); return s; }
function splitFM(text){
  const m = text.match(/^---\n([\s\S]*?)\n---[ \t]*(\n|$)/);
  if (!m) return { props: null, body: text, off: 0 };
  const props = []; let cur = null;
  for (const line of m[1].split("\n")){
    const kv = line.match(/^([^\s:#-][^:]*):\s*(.*)$/);
    if (kv){
      let v = kv[2].trim();
      if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(",").map(unq).filter(Boolean);
      else v = v === "" ? [] : unq(v);
      cur = [kv[1].trim(), v]; props.push(cur); continue;
    }
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && cur){ if (!Array.isArray(cur[1])) cur[1] = [cur[1]]; cur[1].push(unq(li[1])); }
  }
  return { props, body: text.slice(m[0].length), off: m[0].length };
}
let RULES = [];
function chipClass(v){ for (const [cls, re] of RULES) if (re.test(v)) return cls; return ""; }
function renderProp([k, v]){
  if (asList(S.cfg.hideProps).includes(k)) return "";
  const vals = asList(v);
  if (!vals.length) return "";
  const label = (S.cfg.propLabels && S.cfg.propLabels[k]) || k;
  return `<span class="prop"><b>${esc(label)}</b><span class="pv">${vals.map(x => `<span class="chip ${chipClass(String(x))}">${wikiInline(String(x))}</span>`).join("")}</span></span>`;
}
function wikiLink(inner){
  inner = inner.replace(/\\\|/g, "|");
  const [target, alias] = inner.split("|");
  const [name, frag = ""] = target.split("#");
  const label = alias || (frag ? (name ? `${name} › ${frag}` : frag) : name);
  return `<a class="wl" href="#" data-to="${esc(name.trim())}" data-frag="${esc(frag.trim())}">${esc(label)}</a>`;
}
function wikiInline(s){
  return s.split(/(\[\[[^\]\n]+?\]\])/g).map((p, i) => i % 2 ? wikiLink(p.slice(2, -2)) : esc(p)).join("");
}
function wikify(md){
  return md.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g).map((part, i) => i % 2 ? part : part
    .replace(/!\[\[([^\]\n]+?)\]\]/g, (m, x) => `<span class="embed">⧉ ${esc(x)} — ${esc(t("embed"))}</span>`)
    .replace(/\[\[([^\]\n]+?)\]\]/g, (m, inner) => wikiLink(inner))
  ).join("");
}
function resolvePath(from, href){
  const dir = from.path.split("/").slice(0, -1);
  for (const seg of href.split("/")){ if (seg === "..") dir.pop(); else if (seg && seg !== ".") dir.push(seg); }
  return dir.join("/");
}
function findFile(name, path){
  if (path) return S.byPath.get(path.toLowerCase()) || null;
  if (!name) return null;
  const n = name.toLowerCase().replace(/\.(md|markdown)$/i, "");
  return S.byName.get(n) || S.byPath.get(n + ".md") || S.byName.get(n.split("/").pop()) || null;
}
const blobCache = new Map();
async function blobUrl(path){
  if (blobCache.has(path)) return blobCache.get(path);
  const parts = path.split("/"); const name = parts.pop();
  const dir = await dirAt(S.root, parts.join("/"));
  const url = URL.createObjectURL(await (await dir.getFileHandle(name)).getFile());
  blobCache.set(path, url); return url;
}
function postProcess(f, wrap){
  const used = new Set();
  wrap.querySelectorAll(".body h1,.body h2,.body h3,.body h4,.body h5,.body h6").forEach(h => {
    let id = f.id + "--" + (slug(h.textContent) || "h"); while (used.has(id)) id += "-"; used.add(id); h.id = id;
  });
  wrap.querySelectorAll("a[href]").forEach(a => {
    if (a.classList.contains("wl")){
      if (!a.dataset.to) a.dataset.self = f.id;
      else if (!findFile(a.dataset.to)) { a.classList.add("missing"); a.title = t("missingLink"); }
      return;
    }
    const href = a.getAttribute("href");
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)){ a.target = "_blank"; a.rel = "noopener"; return; }
    let [p, frag = ""] = href.split("#");
    try{ p = decodeURIComponent(p); frag = decodeURIComponent(frag); }catch(e){}
    if (!p){ a.classList.add("wl"); a.dataset.self = f.id; a.dataset.frag = frag; return; }
    if (!/\.(md|markdown)$/i.test(p)) return;
    const tgt = findFile(null, resolvePath(f, p));
    a.classList.add("wl"); a.dataset.path = tgt ? tgt.path : ""; a.dataset.frag = frag;
    if (!tgt){ a.classList.add("missing"); a.title = t("missingLink"); }
  });
  wrap.querySelectorAll(".body img[src]").forEach(img => {
    const src = img.getAttribute("src");
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return;
    let p = src; try{ p = decodeURIComponent(src); }catch(e){}
    blobUrl(resolvePath(f, p)).then(u => { img.src = u; }).catch(() => {});
  });
  wrap.querySelectorAll('.body input[type="checkbox"]').forEach((cb, i) => {
    cb.disabled = false; cb.title = t("checkboxTip");
    cb.addEventListener("change", () => toggleTask(f, i, cb.checked));
  });
}
function taskLines(body){
  const lines = body.split("\n"), out = []; let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)){ fence = !fence; return; }
    if (!fence && /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(l)) out.push(i);
  });
  return { lines, out };
}
function toggleTask(f, idx, checked){
  const head = f.text.slice(0, f.bodyOff), body = f.text.slice(f.bodyOff);
  const { lines, out } = taskLines(body);
  const li = out[idx];
  if (li === undefined){ toast(t("taskNotFound")); render(f); return; }
  lines[li] = lines[li].replace(/\[[ xX]\]/, checked ? "[x]" : "[ ]");
  f.text = head + lines.join("\n"); touch(f);
}

/* ---------- navigation ---------- */
function reveal(f, frag){
  if (f.el.classList.contains("hide")){
    if (S.hidden.has(f.group)){ S.hidden.delete(f.group); putState({ hidden: [...S.hidden] }); const p = f.path; build(); f = S.files.find(x => x.path === p); }
    if (f.el.classList.contains("hide")){ $("#q").value = ""; S.q = ""; S.files.forEach(x => { if (x.mode === "view") render(x); }); applyFilter(); }
  }
  let target = f.el;
  if (frag){
    const fl = frag.toLowerCase().trim(), fs = slug(frag);
    const hs = [...f.el.querySelectorAll(".body h1,.body h2,.body h3,.body h4,.body h5,.body h6")];
    const txt = h => h.textContent.trim().toLowerCase();
    target = hs.find(h => txt(h) === fl) || hs.find(h => slug(h.textContent) === fs) || hs.find(h => txt(h).startsWith(fl)) || f.el;
  }
  target.scrollIntoView({ block: "start" });
  target.classList.remove("flash"); void target.offsetWidth; target.classList.add("flash");
}
$("#doc").addEventListener("click", e => {
  const a = e.target.closest("a.wl"); if (!a) return;
  e.preventDefault();
  const self = a.dataset.self ? S.files.find(x => x.id === a.dataset.self) : null;
  const f = self || (a.dataset.path ? findFile(null, a.dataset.path) : findFile(a.dataset.to));
  if (f) reveal(f, a.dataset.frag); else toast(t("notFound"));
});
$("#doc").addEventListener("dblclick", e => {
  const sec = e.target.closest(".file"); if (!sec || e.target.closest("a,input,button,textarea")) return;
  const f = S.files.find(x => x.id === sec.id);
  if (f && f.mode === "view"){ const sel = window.getSelection(); if (sel) sel.removeAllRanges(); setMode(f, "edit", true); }
});

/* ---------- search ---------- */
function applyFilter(){
  const q = S.q.toLowerCase(); let n = 0;
  for (const f of S.files){
    const hit = !q || f.text.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
    const show = hit && (!S.hidden.has(f.group) || !!q);
    f.el.classList.toggle("hide", !show); f.nav.classList.toggle("hide", !hit);
    if (show) n++;
  }
  S.found = q ? n : null;
  updateGlobal(); onScroll();
}
function highlight(root, q){
  const ql = q.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes = []; let nd;
  while ((nd = walker.nextNode())) if (nd.nodeValue.toLowerCase().includes(ql)) nodes.push(nd);
  for (const tn of nodes){
    const s = tn.nodeValue, lo = s.toLowerCase(); const fr = document.createDocumentFragment(); let i = 0, j;
    while ((j = lo.indexOf(ql, i)) >= 0){ fr.append(s.slice(i, j)); const m = document.createElement("mark"); m.textContent = s.slice(j, j + q.length); fr.append(m); i = j + q.length; }
    fr.append(s.slice(i)); tn.replaceWith(fr);
  }
}
let qT;
$("#q").addEventListener("input", e => {
  clearTimeout(qT);
  qT = setTimeout(() => {
    S.q = e.target.value.trim();
    S.files.forEach(f => { if (f.mode === "view") render(f); });
    applyFilter();
    const first = S.files.find(f => !f.el.classList.contains("hide"));
    if (S.q && first){ const m = first.el.querySelector("mark"); (m || first.el).scrollIntoView({ block: "center" }); }
  }, 200);
});

/* ---------- saving ---------- */
function touch(f){
  f.dirty = true; setStat(f);
  clearTimeout(f.timer); f.timer = setTimeout(() => save(f), 900);
}
function setStat(f){
  const st = f.el.querySelector(".fstat");
  st.className = "fstat " + (f.err ? "err" : f.saving ? "" : f.dirty ? "dirty" : f.savedAt ? "ok" : "");
  st.textContent = f.err ? "⚠ " + f.err : f.saving ? t("saving") : f.dirty ? t("unsaved") : f.savedAt ? t("saved", { t: f.savedAt }) : "";
  f.nav.classList.toggle("dirty", !!f.dirty);
  updateGlobal();
}
function updateGlobal(){
  const g = $("#gstatus");
  const d = S.files.filter(f => f.dirty).length, err = S.files.some(f => f.err);
  g.className = err ? "err" : d ? "dirty" : "";
  g.textContent = [S.found != null ? t("found", { n: S.found }) : "",
    err ? t("saveErrors") : d ? t("unsavedN", { n: d }) : S.files.length ? t("allSaved") : ""].filter(Boolean).join(" · ");
}
function encode(f, text){
  return (f.bom ? "﻿" : "") + (f.crlf ? text.replace(/\n/g, "\r\n") : text);
}
async function save(f){
  clearTimeout(f.timer);
  if (f.saving){ f.again = true; return f.saving; }
  if (!f.dirty) return true;
  f.saving = (async () => {
    try{
      const disk = await f.handle.getFile();
      if (disk.lastModified !== f.diskMod){
        const dt = await rawText(disk);
        if (dt !== f.diskText){
          if (!confirm(t("conflict", { path: f.path }))){
            try{ await navigator.clipboard.writeText(f.text); }catch(e){}
            await readFile(f); f.dirty = false; render(f); return true;
          }
        }
      }
      const snapshot = f.text, out = encode(f, snapshot);
      const w = await f.handle.createWritable(); await w.write(out); await w.close();
      f.diskMod = (await f.handle.getFile()).lastModified; f.diskText = out;
      if (f.text === snapshot) f.dirty = false;
      f.err = null; f.savedAt = new Date().toLocaleTimeString(LANG, { hour: "2-digit", minute: "2-digit" });
      return true;
    }catch(e){
      f.err = e.name === "NotAllowedError" ? t("errNoWrite") : t("errSave", { m: e.message });
      return false;
    }
  })();
  setStat(f);
  const ok = await f.saving;
  f.saving = null; setStat(f);
  if (f.again){ f.again = false; if (f.dirty) return save(f); }
  return ok;
}
async function flushAll(){
  const r = await Promise.all(S.files.filter(f => f.dirty || f.saving).map(save));
  return !r.includes(false);
}
async function refreshFromDisk(full){
  if (!S.root) return;
  if (full){ await flushAll(); savePosition(); await load(S.root, { keepScroll: $("#doc").scrollTop }); return; }
  for (const f of S.files){
    if (f.dirty || f.saving) continue;
    try{
      const file = await f.handle.getFile();
      if (file.lastModified !== f.diskMod){
        await readFile(f);
        if (f.mode === "edit" && f.ta){ if (document.activeElement !== f.ta){ f.ta.value = f.text; autosize(f.ta); } }
        else render(f);
      }
    }catch(e){ /* removed or renamed on disk — picked up by a full reload */ }
  }
}

/* ---------- wiring ---------- */
function applyLabels(){
  RULES = statusRules();
  $("#q").placeholder = t("search");
  $("#btnEditAll").textContent = S.editAll ? t("editAllDone") : t("editAll"); $("#btnEditAll").title = t("editAllTip");
  $("#btnRefresh").textContent = t("refresh"); $("#btnRefresh").title = t("refreshTip");
  $("#btnOpen").textContent = S.root ? t("openOther") : t("open");
}
$("#btnOpen").onclick = pickFolder;
$("#btnRefresh").onclick = () => refreshFromDisk(true);
$("#btnEditAll").onclick = () => {
  S.editAll = !S.editAll; $("#btnEditAll").classList.toggle("on", S.editAll);
  $("#btnEditAll").textContent = S.editAll ? t("editAllDone") : t("editAll");
  const anchor = S.active;
  S.files.forEach(f => { f.mode = S.editAll ? "edit" : "view"; render(f); });
  if (anchor) requestAnimationFrame(() => anchor.el.scrollIntoView({ block: "start" }));
};
window.addEventListener("keydown", e => {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "s"){ e.preventDefault(); flushAll().then(ok => toast(ok ? t("savedToast") : t("notAllSaved"))); }
  if ((e.ctrlKey || e.metaKey) && k === "f" && S.files.length){ e.preventDefault(); $("#q").focus(); $("#q").select(); }
});
window.addEventListener("focus", () => refreshFromDisk(false));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden"){ savePosition(); flushAll(); } else refreshFromDisk(false); });
window.addEventListener("pagehide", savePosition);
window.addEventListener("beforeunload", e => {
  savePosition();
  if (S.files.some(f => f.dirty || f.saving)){ flushAll(); e.preventDefault(); e.returnValue = ""; }
});

(async function init(){
  setLang(null); applyLabels();
  $("#wtitle").textContent = t("welcomeTitle");
  $("#wtext").innerHTML = t("welcomeText");
  $("#wkeys").innerHTML = t("welcomeKeys");
  if (!("showDirectoryPicker" in window)){ $("#btnOpen").disabled = true; $("#wnote").innerHTML = t("noFS"); return; }
  const recent = (await kvGet("recent")) || [];
  if (recent.length){
    try{ if ((await recent[0].handle.queryPermission({ mode: "readwrite" })) === "granted"){ await load(recent[0].handle); return; } }catch(e){}
  }
  const btns = $("#wbtns");
  if (recent[0]){
    const b = document.createElement("button"); b.className = "primary"; b.textContent = t("cont", { name: recent[0].name });
    b.onclick = () => openRemembered(recent[0].handle); btns.append(b);
  }
  const p = document.createElement("button"); p.className = recent.length ? "" : "primary"; p.textContent = t("pick"); p.onclick = pickFolder; btns.append(p);
  if (recent.length > 1){
    const box = $("#wrecent"); box.innerHTML = `<h2>${esc(t("recent"))}</h2>`;
    for (const r of recent.slice(1)){
      const st = lsGet("opd:state:" + r.name, {});
      const b = document.createElement("button");
      b.innerHTML = esc(r.name) + (st.path ? `<small>${esc(t("lastDoc", { doc: stem(st.path) }))}</small>` : "");
      b.onclick = () => openRemembered(r.handle); box.append(b);
    }
  }
})();
