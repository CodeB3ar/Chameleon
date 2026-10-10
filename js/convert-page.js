/* Chameleon — convert page: merged Choose + Convert, progress, download view.
   Drop tab holds up to MAX_FILES uploads (1-2: long banners, 3+: grid).
   Choose tab lists files with a SHOW toggle: ALL FILES applies one target to
   everything (single family only); CUSTOM gives each file its own target.
   Mixed families lock bulk and force custom. Non-image files list as stubs
   (coming soon) and are skipped at convert. Convert runs every convertible
   file sequentially; results list with per-file Download + Download all.
   Everything stays on-device. */

import { initScramble } from "./scramble.js";
import { getStaged, stagedTargetFallback } from "./store.js";
import {
  isSupported,
  stubKind,
  fmtSize,
  extOf,
  familyOf,
  isKnown,
  targetsFor,
  defaultTargetFor,
  CONVERTIBLE_TARGETS,
  AUDIO_CONVERTIBLE_TARGETS,
} from "./convert.js";
import { decodeImage, encodeImage, supportsWebp, getImageDimensions, outName } from "./encode.js";
import {
  decodeAudio,
  encodeAudio,
  supportsAudioTarget,
  ensureLame,
  bitrateForQuality,
  bitrateLabel,
  getAudioDuration,
  fmtDuration,
  outNameAudio,
  LOSSLESS_TARGETS,
} from "./encode-audio.js";

const MAX_FILES = 10;
const GRID_FROM = 3; // < GRID_FROM files: long banner; >= GRID_FROM: grid
const REAL_TARGETS = ["PNG", "JPG", "SVG", "WEBP"];
const REAL_AUDIO_TARGETS = ["MP3", "WAV", "OGG", "FLAC", "AAC", "M4A"];
// Shell estimate weights (used until a real conversion measures bytes).
// SVG wraps a PNG raster as base64, so it runs larger than the source.
const WEIGHTS = { PNG: 1.0, JPG: 0.45, SVG: 1.35, WEBP: 0.35 };
// Audio weights mirror the photo approach: lossy shrinks, WAV grows to PCM,
// FLAC lands near the source. Quality scales lossy targets only.
const AUDIO_WEIGHTS = { MP3: 0.32, AAC: 0.3, OGG: 0.27, M4A: 0.3, FLAC: 0.85, WAV: 1.4 };
const BASE = 1.2;

const $ = (id) => document.getElementById(id);
const h1txt = $("h1txt");
const tab1 = $("tab1");
const tab2 = $("tab2");
const tab3 = $("tab3");
const tabs = [tab1, tab2, tab3];
const viewDrop = $("view-drop");
const viewChoose = $("view-choose");
const viewDl = $("view-dl");
const dropEmpty = $("drop-empty");
const convertDrop = $("convert-drop");
const emptyBrowseBtn = $("empty-browse-btn");
const fileGrid = $("file-grid");
const changeBtn = $("change-btn");
const changeInput = $("change-input");
const toChoose = $("to-choose");
const singleCard = $("single-card");
const singleImg = $("single-img");
const singleName = $("single-name");
const singleMeta = $("single-meta");
const showBlk = $("show-blk");
const modeAll = $("mode-all");
const modeManual = $("mode-manual");
const modeNote = $("mode-note");
const filerows = $("filerows");
const tilesBlk = $("tiles-blk");
const tilesEl = $("tiles");
let tiles = [...document.querySelectorAll("#tiles .tile")];
const qBlk = $("q-blk");
const q = $("q");
const qv = $("qv");
const eg = $("eg");
const btn = $("btn");
const prog = $("prog");
const pbar = $("pbar");
const pbarwrap = $("pbarwrap");
const plabel = $("plabel");
const src = $("src");
const sz = $("sz");
const tr = $("tr");
const qr = $("qr");
const er = $("er");
const bl = $("bl");
const bs = $("bs");
const bar = $("bar");
const pc = $("pc");
const pw = $("pw");
const origLabel = $("orig-label");
const origSize = $("orig-size");
const rname = $("rname");
const rmeta = $("rmeta");
const resultsEl = $("results");
const dl = $("dl");
const dlAll = $("dl-all");
const backSettings = $("back-settings");
const againBtn = $("again-btn");
const readout = $("readout");
const bacard = $("bacard");
const statusEl = $("convert-status");

const files = []; // { hid, blob, name, size, type, url?, family, target }
let activeIndex = 0;
let file = null; // files[activeIndex], synced via syncActive()
let srcExt = "PNG";
let target = "WEBP"; // global (bulk) target
let mode = "bulk"; // "bulk" | "manual"
let extraCount = 0;
let busy = false;
let activeTab = 2;
let results = []; // { entryName, blob, url, name, size, target, quality }
let seq = 0;
const dimsCache = new Map(); // hid -> { w, h } | null (null = undecodable here)
const dimsPending = new Set(); // hids with an in-flight dimension decode
const durCache = new Map(); // hid -> seconds | null
const durPending = new Set();
let dimsReq = 0;

function setStatus(msg) {
  try {
    if (typeof console !== "undefined" && msg) console.debug("[chameleon]", msg);
    if (statusEl) statusEl.textContent = msg || "";
  } catch {
    // status is best-effort narration, never fatal
  }
}

// Format-driven accent: selected output format re-themes page accents via
// .pg[data-format] (css). HEIC/unknown never drive the theme — keep last.
const pg = document.querySelector(".pg");
function setFormatTheme(fmt) {
  if (!pg) return;
  const map = {
    png: "png", jpg: "jpg", jpeg: "jpg", svg: "svg", webp: "webp",
    mp3: "mp3", wav: "wav", ogg: "ogg", flac: "flac", aac: "aac", m4a: "m4a",
  };
  const next = map[String(fmt || "").toLowerCase()];
  if (!next) return;
  if (pg.dataset.format !== next) pg.dataset.format = next;
}

// Tab-aware accent: Drop follows the SOURCE file type, Choose/Download follow
// the output TARGET. Other families (heic/audio/video/doc) keep last theme.
function syncPageTheme() {
  if (!pg || !file) return;
  if (activeTab === 1) setFormatTheme(srcExtOf(file.name));
  else setFormatTheme(activeTarget());
}

function syncActive() {
  file = files[activeIndex] || null;
}

function convertible(entry) {
  if (!entry) return false;
  if (entry.family === "image") return CONVERTIBLE_TARGETS.includes(entry.target);
  if (entry.family === "audio") return AUDIO_CONVERTIBLE_TARGETS.includes(entry.target);
  return false;
}

function isAudioEntry(entry) {
  return !!entry && entry.family === "audio";
}

function convertibleCount() {
  return files.filter(convertible).length;
}

function bulkAvailable() {
  if (!files.length) return false;
  return new Set(files.map((f) => f.family)).size === 1;
}

/** Enforce mode lock: mixed families force custom. Updates toggle UI. */
function syncMode() {
  const ok = bulkAvailable();
  if (!ok) mode = "manual";
  modeAll.disabled = !ok || busy;
  modeManual.disabled = busy;
  modeAll.classList.toggle("on", mode === "bulk");
  modeManual.classList.toggle("on", mode === "manual");
  modeAll.setAttribute("aria-pressed", String(mode === "bulk"));
  modeManual.setAttribute("aria-pressed", String(mode === "manual"));
  modeAll.innerHTML = `All files &middot; ${files.length}`;
  modeNote.hidden = ok;
  if (!ok && files.length) {
    modeNote.textContent = "Mixed file types — bulk is locked. Set each file with Custom.";
    modeNote.hidden = false;
  }
  // Tiles/quality drive bulk conversion; hide them when bulk can't act.
  const showBulkCtrls = mode === "bulk" && ok && files.some((f) => convertible(f) || f.family === "image" || f.family === "audio");
  tilesBlk.hidden = !showBulkCtrls && !(mode === "manual" && files.length === 1);
  qBlk.hidden = convertibleCount() === 0;
  // Multi-file: drop the per-file readout, keep the before/after card top-right at natural size.
  const multi = files.length > 1;
  readout.hidden = multi;
  bacard.classList.toggle("flat", multi);
}

function syncTabs() {
  const canChoose = !!file && !busy;
  const canDl = results.length > 0 && !busy;
  tab1.disabled = busy;
  tab2.disabled = !canChoose;
  tab3.disabled = !canDl;
  tabs.forEach((t, i) => t.setAttribute("aria-selected", String(i + 1 === activeTab)));
  tab1.classList.toggle("on", activeTab === 1);
  tab2.classList.toggle("on", activeTab === 2);
  tab3.classList.toggle("on", activeTab === 3);
  tab1.classList.toggle("past", activeTab > 1 && !!file);
  tab2.classList.toggle("past", activeTab > 2 && results.length > 0);
  syncPageTheme();
}

function goTab(n) {
  if (busy) return;
  if (n === 2 && !file) return;
  if (n === 3 && !results.length) return;
  activeTab = n;
  viewDrop.hidden = n !== 1;
  viewChoose.hidden = n !== 2;
  viewDl.hidden = n !== 3;
  syncTabs();
}

function thumbUrl(blob, type, name) {
  const t = String(type || "").toLowerCase();
  const n = String(name || (blob && blob.name) || "").toLowerCase();
  const isImg =
    t.startsWith("image/") ||
    [".png", ".jpg", ".jpeg", ".svg", ".webp", ".heic", ".heif"].some((e) => n.endsWith(e));
  const isAudio =
    t.startsWith("audio/") ||
    [".mp3", ".wav", ".flac", ".aac", ".ogg", ".oga", ".opus", ".m4a", ".weba", ".3gp"].some((e) => n.endsWith(e));
  if (!isImg && !isAudio) return null;
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function isImageEntry(entry) {
  return !!entry && entry.family === "image";
}

function srcExtOf(name) {
  return (extOf(name) || ".png").slice(1).toUpperCase() || "PNG";
}

function activeTarget() {
  return (file && file.target) || target;
}

function estimateKBFor(entry) {
  const srcKB = Math.max(1, entry.size / 1024);
  const v = +q.value;
  if (isAudioEntry(entry)) {
    const w = AUDIO_WEIGHTS[entry.target] || 0.32;
    // Lossless targets ignore quality (mirrors PNG + FAQ copy).
    const qf = LOSSLESS_TARGETS.includes(entry.target) ? 1 : 0.4 + (0.98 * v) / 100;
    return ((srcKB * w) / BASE) * qf * 1.35;
  }
  return (srcKB * (WEIGHTS[entry.target] || 0.4)) / BASE * (0.4 + (0.98 * v) / 100);
}

function fmtKB(kb) {
  return kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : Math.round(kb) + " KB";
}

function tilesFamily() {
  if (!files.length) return (file && file.family) || "image";
  if (mode === "bulk" && bulkAvailable()) return files[0].family;
  return (file && file.family) || files[0].family;
}

function onTileClick(fmt) {
  if (!file || busy) return;
  target = fmt;
  // Theme first: page accents + selected tile recolour even if a render below throws.
  setFormatTheme(target);
  const fam = tilesFamily();
  if (mode === "bulk") {
    files.forEach((f) => {
      if (f.family !== fam) return;
      if (fam === "image" && REAL_TARGETS.includes(target)) f.target = target;
      if (fam === "audio" && REAL_AUDIO_TARGETS.includes(target)) f.target = target;
    });
  } else if (file.family === fam) {
    file.target = target;
  }
  clearResults();
  syncTiles();
  renderEstimate();
  renderRows();
  renderGridSubs();
  syncPageTheme();
}

function renderTiles() {
  const fam = tilesFamily();
  const defs = fam === "audio" ? REAL_AUDIO_TARGETS : [...REAL_TARGETS, "HEIC"];
  tilesEl.innerHTML = "";
  defs.forEach((f) => {
    const b = document.createElement("button");
    b.className = "tile";
    b.type = "button";
    b.dataset.f = f;
    b.setAttribute("aria-pressed", "false");
    b.textContent = f;
    b.addEventListener("click", () => onTileClick(f));
    tilesEl.appendChild(b);
  });
  tiles = [...tilesEl.querySelectorAll(".tile")];
  syncTiles();
  syncTileAvailability();
}

function syncTiles() {
  // Bulk: highlight follows the global target; manual: the active file's.
  const eff = mode === "bulk" ? target : activeTarget();
  tiles.forEach((b) => {
    const on = b.dataset.f === eff;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

/** Visible sub-label on a disabled tile (e.g. "INPUT ONLY"), idempotent. */
function labelTile(btn, text) {
  if (!btn || btn.querySelector(".tile-tag")) return;
  btn.classList.add("has-tag");
  const s = document.createElement("small");
  s.className = "tile-tag";
  s.setAttribute("aria-hidden", "true");
  s.textContent = text;
  btn.appendChild(s);
  btn.setAttribute("aria-label", `${btn.dataset.f} — ${text.toLowerCase()}`);
}

/** Re-apply capability-based availability after busy ends or at init. */
function syncTileAvailability() {
  const fam = tilesFamily();
  tiles.forEach((b) => {
    if (busy) {
      b.disabled = true;
      return;
    }
    b.disabled = false;
  });
  if (busy) return;
  if (fam === "image") {
    if (!supportsWebp()) {
      const w = tiles.find((b) => b.dataset.f === "WEBP");
      if (w) {
        w.disabled = true;
        w.title = "This browser can't encode WebP — JPG works.";
        labelTile(w, "NO SUPPORT");
      }
    }
    // HEIC is input-only — never a valid output target.
    const h = tiles.find((b) => b.dataset.f === "HEIC");
    if (h) {
      h.disabled = true;
      h.title = "HEIC is input-only — pick another output format.";
      labelTile(h, "INPUT ONLY");
    }
    return;
  }
  if (fam === "audio") {
    tiles.forEach((b) => {
      if (!supportsAudioTarget(b.dataset.f)) {
        b.disabled = true;
        b.title = `${b.dataset.f} encoding isn't supported in this browser — WAV works everywhere.`;
        labelTile(b, "NO SUPPORT");
      }
    });
  }
}

function syncConvertBtn() {
  const n = convertibleCount();
  btn.disabled = n === 0 || busy;
  btn.innerHTML =
    files.length > 1 ? `Convert ${n} file${n === 1 ? "" : "s"} &rarr;` : `Convert to ${activeTarget()} &rarr;`;
  btn.title =
    n === 0 ? "Nothing convertible yet — images convert to PNG / JPG / SVG / WEBP, audio to MP3 / WAV / OGG / FLAC / AAC / M4A." : "";
}

function renderEstimate() {
  const at = activeTarget();
  const v = +q.value;
  const audioActive = !!file && isAudioEntry(file);
  qv.textContent = audioActive && !LOSSLESS_TARGETS.includes(at) ? `${v}% · ${bitrateLabel(v, at)}` : v + "%";
  qr.textContent = audioActive && !LOSSLESS_TARGETS.includes(at) ? `${v} · ${bitrateLabel(v, at)}` : v;
  tr.textContent = at;
  // Multi-file: aggregate totals across convertible files (mixed types
  // included) instead of showing the active file alone.
  const multi = files.length > 1;
  const jobs = multi ? files.filter(convertible) : [file];
  const skipped = files.length - jobs.length;
  const totalInB = jobs.reduce((a, f) => a + f.size, 0);
  const totalInKB = totalInB / 1024;
  const totalEst = jobs.reduce((a, f) => a + estimateKBFor(f), 0);
  const outLabel = !multi ? at : mode === "bulk" ? target : "Mixed";
  if (!totalInB) {
    er.textContent = "—";
    bs.textContent = "—";
    eg.textContent = "Nothing convertible yet";
    bl.innerHTML = outLabel + " &middot; Estimated";
    bar.style.width = "0%";
    pc.textContent = "—";
    pw.textContent = "smaller";
  } else {
    const pct = Math.round((1 - totalEst / totalInKB) * 100);
    er.textContent = "~" + fmtKB(totalEst);
    bs.textContent = "~" + fmtKB(totalEst);
    eg.innerHTML =
      "Estimated output ~" + fmtKB(totalEst) + (skipped ? ` &middot; excludes ${skipped} skipped` : "");
    bl.innerHTML = outLabel + " &middot; Estimated";
    bar.style.width = Math.min(100, (totalEst / totalInKB) * 100) + "%";
    pc.textContent = Math.abs(pct) + "%";
    pw.textContent = pct >= 0 ? "smaller" : "larger";
  }
  if (multi) {
    origLabel.textContent = `${files.length} files · Original`;
    origSize.textContent = fmtSize(totalInB);
  } else {
    origLabel.textContent = srcExt + " · Original";
    origSize.textContent = fmtSize(file.size);
  }
  syncConvertBtn();
}

/** Before-and-after bars from measured post-convert totals. */
function renderMeasured() {
  const totalIn = results.reduce((a, r) => a + (r.srcSize || 0), 0);
  const totalOut = results.reduce((a, r) => a + r.size, 0);
  if (!totalIn) return;
  const targets = [...new Set(results.map((r) => r.target))];
  const outLabel = (targets.length === 1 ? targets[0] : "Mixed") + " · Converted";
  const pct = Math.round((1 - totalOut / totalIn) * 100);
  er.textContent = fmtSize(totalOut);
  bs.textContent = fmtSize(totalOut);
  eg.innerHTML = "Output " + fmtSize(totalOut);
  bl.innerHTML = outLabel;
  if (files.length > 1) {
    origLabel.textContent = `${results.length} files · Original`;
    origSize.textContent = fmtSize(totalIn);
  }
  bar.style.width = Math.min(100, (totalOut / totalIn) * 100) + "%";
  pc.textContent = Math.abs(pct) + "%";
  pw.textContent = pct >= 0 ? "smaller" : "larger";
}

/** Image thumbnail when available, orange ext badge otherwise (same box). */
function thumbOrBadge(url, name) {
  if (url) {
    const thumb = document.createElement("span");
    thumb.className = "thumb";
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    // HEIC previews fail on Chrome/Firefox — fall back to ext badge.
    img.onerror = () => {
      thumb.textContent = srcExtOf(name);
    };
    thumb.appendChild(img);
    return thumb;
  }
  const badge = document.createElement("span");
  badge.className = "badge sm";
  badge.textContent = srcExtOf(name);
  return badge;
}

function renderResults(failed = []) {
  const failedList = Array.isArray(failed) ? failed : [];
  const totalIn = files.reduce((a, f) => a + f.size, 0);
  const totalOut = results.reduce((a, r) => a + r.size, 0);
  // "Unsupported" = never attempted (stub family); "failed" = attempted but errored.
  const unsupported = files.filter((f) => !convertible(f)).length;
  rname.textContent = `${results.length} file${results.length === 1 ? "" : "s"} converted`;
  const qSuffix = results.some((r) => AUDIO_CONVERTIBLE_TARGETS.includes(r.target) && !LOSSLESS_TARGETS.includes(r.target))
    ? `quality ${q.value} · ${bitrateLabel(+q.value, results[0].target)}`
    : `quality ${q.value}`;
  rmeta.textContent =
    `${fmtSize(totalIn)} → ${fmtSize(totalOut)} · ${qSuffix}` +
    (failedList.length ? ` · ${failedList.length} failed` : "") +
    (unsupported ? ` · ${unsupported} not yet supported` : "");
  resultsEl.innerHTML = "";
  resultsEl.hidden = results.length === 0 && failedList.length === 0;
  results.forEach((r) => {
    const li = document.createElement("li");
    li.className = "frow done";
    li.append(thumbOrBadge(r.thumb, r.name));
    const nm = document.createElement("span");
    nm.className = "fn";
    nm.textContent = r.name;
    nm.title = r.name;
    const meta = document.createElement("span");
    meta.className = "fs";
    meta.textContent = fmtSize(r.size);
    const a = document.createElement("a");
    a.className = "link";
    a.href = r.url;
    a.download = r.name;
    a.textContent = "Download";
    li.append(nm, meta, a);
    resultsEl.appendChild(li);
  });
  failedList.forEach((f) => {
    const li = document.createElement("li");
    li.className = "frow dim";
    const badge = document.createElement("span");
    badge.className = "badge sm";
    badge.textContent = "!";
    badge.title = "Conversion failed";
    const nm = document.createElement("span");
    nm.className = "fn";
    nm.textContent = f.name;
    nm.title = f.name;
    const meta = document.createElement("span");
    meta.className = "fs";
    meta.textContent = f.reason;
    meta.title = f.reason;
    li.append(badge, nm, meta);
    resultsEl.appendChild(li);
  });
  if (results.length === 1) {
    dl.href = results[0].url;
    dl.download = results[0].name;
    dl.hidden = false;
    dlAll.hidden = true;
  } else if (results.length > 1) {
    dl.hidden = true;
    dlAll.hidden = false;
  } else {
    dl.hidden = true;
    dlAll.hidden = true;
  }
  er.textContent = fmtSize(totalOut);
}

/** Large preview card for the single-file case (image thumb or audio player). */
function renderSingleCard() {
  const show = files.length === 1 && !!file && (file.family === "image" || file.family === "audio");
  singleCard.hidden = !show;
  if (!show) return;
  const entry = file;
  const thumbBox = singleImg.parentElement;
  singleName.textContent = entry.name;
  singleName.title = entry.name;
  let player = document.getElementById("single-audio");
  const showAudio = entry.family === "audio";
  if (player) player.hidden = !showAudio;
  // Rebuild thumb so a previous HEIC fallback can't leak into the next file.
  thumbBox.textContent = "";
  if (showAudio) {
    singleImg.hidden = true;
    singleImg.removeAttribute("src");
    const badge = document.createElement("span");
    badge.className = "badge sm";
    badge.textContent = srcExtOf(entry.name);
    thumbBox.append(badge, singleImg);
    if (player) {
      try {
        if (player.getAttribute("src") !== entry.url) player.src = entry.url || "";
      } catch {
        // ignore
      }
    }
  } else {
    if (entry.url) {
      singleImg.hidden = false;
      if (singleImg.getAttribute("src") !== entry.url) singleImg.src = entry.url;
      singleImg.alt = entry.name;
      singleImg.onerror = () => {
        singleImg.hidden = true;
        thumbBox.textContent = srcExtOf(entry.name);
        thumbBox.appendChild(singleImg);
      };
      thumbBox.appendChild(singleImg);
    } else {
      singleImg.hidden = true;
      singleImg.removeAttribute("src");
      thumbBox.textContent = srcExtOf(entry.name);
      thumbBox.appendChild(singleImg);
    }
  }
  const metaBase = () => `${srcExtOf(entry.name)} · ${fmtSize(entry.size)} → ${activeTarget()}`;
  if (entry.family === "audio") {
    const cached = durCache.get(entry.hid);
    const withRate = (base) =>
      LOSSLESS_TARGETS.includes(activeTarget()) ? base : `${base} · ${bitrateLabel(+q.value, activeTarget())}`;
    if (cached) {
      singleMeta.textContent = withRate(`${metaBase()} · ${fmtDuration(cached)}`);
    } else if (cached === null) {
      singleMeta.textContent = withRate(metaBase());
    } else if (durPending.has(entry.hid)) {
      singleMeta.textContent = `${metaBase()} · …`;
    } else {
      singleMeta.textContent = `${metaBase()} · …`;
      durPending.add(entry.hid);
      const req = ++dimsReq;
      getAudioDuration(entry.blob).then((d) => {
        durPending.delete(entry.hid);
        durCache.set(entry.hid, d || null);
        if (req !== dimsReq || !file || file.hid !== entry.hid || singleCard.hidden) return;
        singleMeta.textContent = d ? withRate(`${metaBase()} · ${fmtDuration(d)}`) : withRate(metaBase());
      });
    }
    return;
  }
  const cached = dimsCache.get(entry.hid);
  if (cached) {
    singleMeta.textContent = `${metaBase()} · ${cached.w} × ${cached.h}px`;
  } else if (cached === null) {
    singleMeta.textContent = metaBase();
  } else if (dimsPending.has(entry.hid)) {
    singleMeta.textContent = `${metaBase()} · …`;
  } else {
    singleMeta.textContent = `${metaBase()} · …`;
    dimsPending.add(entry.hid);
    const req = ++dimsReq;
    getImageDimensions(entry.blob, entry.name).then((d) => {
      dimsPending.delete(entry.hid);
      dimsCache.set(entry.hid, d || null);
      if (req !== dimsReq || !file || file.hid !== entry.hid || singleCard.hidden) return;
      singleMeta.textContent = d ? `${metaBase()} · ${d.w} × ${d.h}px` : metaBase();
    });
  }
}

/** File rows on the Choose tab (bulk text vs custom dropdowns). */
function renderRows() {
  const multi = files.length > 1;
  showBlk.hidden = !multi;
  filerows.hidden = !multi;
  filerows.innerHTML = "";
  renderSingleCard();
  if (!multi) return;
  files.forEach((entry, i) => {
    const li = document.createElement("li");
    li.className = "frow" + (convertible(entry) ? "" : " dim");
    li.dataset.index = i;
    li.title = "Select file";
    li.append(thumbOrBadge(entry.url, entry.name));
    const nm = document.createElement("span");
    nm.className = "fn";
    nm.textContent = entry.name;
    nm.title = entry.name;
    const meta = document.createElement("span");
    meta.className = "fs";
    meta.textContent = fmtSize(entry.size);
    li.append(nm, meta);
    if (mode === "bulk") {
      const t = document.createElement("span");
      t.className = "ftarget";
      t.innerHTML = `&rarr; ${entry.target}`;
      li.append(t);
    } else {
      const sel = document.createElement("select");
      sel.className = "mini";
      sel.setAttribute("aria-label", "Target format for " + entry.name);
      sel.disabled = busy;
      targetsFor(entry.family).forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt.v;
        const unsupportedAudio = entry.family === "audio" && !opt.soon && !supportsAudioTarget(opt.v);
        o.textContent = opt.v + (opt.soon ? ` (${(opt.label || "soon").toLowerCase()})` : unsupportedAudio ? " (no support)" : "");
        o.disabled = opt.soon || unsupportedAudio;
        if (opt.v === entry.target) o.selected = true;
        sel.append(o);
      });
      if (sel.selectedIndex < 0) sel.selectedIndex = 0;
      sel.addEventListener("click", (e) => e.stopPropagation());
      sel.addEventListener("change", () => {
        entry.target = sel.value;
        clearResults();
        syncActive();
        renderEstimate();
        syncConvertBtn();
      });
      li.append(sel);
    }
    if (!convertible(entry)) {
      const tag = document.createElement("span");
      tag.className = "soon";
      tag.textContent = "SOON";
      li.append(tag);
    }
    li.addEventListener("click", () => select(i, false));
    filerows.appendChild(li);
  });
}

function renderActiveMeta() {
  srcExt = srcExtOf(file.name);
  src.textContent = file.name;
  sz.textContent = fmtSize(file.size);
  origLabel.textContent = srcExt + " · Original";
  origSize.textContent = fmtSize(file.size);
  toChoose.innerHTML = files.length > 1 ? `Continue with ${file.name} &rarr;` : "Continue &rarr;";
  toChoose.title = files.length > 1 ? file.name : "";
  const multi = files.length > 1;
  const h1 = multi ? "Convert your files" : "Convert your " + srcExt;
  document.title = multi ? "Chameleon — Convert files" : "Chameleon — Convert a " + srcExt;
  h1txt.dataset.text = h1;
  h1txt.textContent = h1;
}

function renderGrid() {
  syncActive();
  fileGrid.innerHTML = "";
  dropEmpty.hidden = files.length > 0;
  fileGrid.hidden = files.length === 0;
  fileGrid.classList.toggle("grid", files.length >= GRID_FROM);
  files.forEach((entry, i) => {
    const li = document.createElement("li");
    li.className = "file-card";
    li.setAttribute("role", "option");
    li.setAttribute("tabindex", "0");
    li.setAttribute("aria-selected", String(i === activeIndex));
    li.setAttribute("aria-label", `${entry.name}, ${fmtSize(entry.size)}`);
    li.dataset.index = i;

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (entry.family === "audio") {
      thumb.textContent = srcExtOf(entry.name);
      thumb.setAttribute("aria-hidden", "true");
    } else if (entry.url) {
      const img = document.createElement("img");
      img.src = entry.url;
      img.alt = "";
      img.loading = "lazy";
      img.onerror = () => {
        thumb.classList.remove("has-img");
        thumb.textContent = srcExtOf(entry.name);
      };
      thumb.appendChild(img);
      thumb.classList.add("has-img");
    } else {
      thumb.textContent = srcExtOf(entry.name);
      thumb.setAttribute("aria-hidden", "true");
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("b");
    name.textContent = entry.name;
    name.title = entry.name;
    const sub = document.createElement("span");
    sub.textContent = `${fmtSize(entry.size)} → ${entry.target}`;
    meta.append(name, sub);

    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.type = "button";
    remove.textContent = "✕";
    remove.setAttribute("aria-label", "Remove " + entry.name);
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAt(i);
    });

    li.append(thumb, meta, remove);
    fileGrid.appendChild(li);
  });
  toChoose.disabled = files.length === 0 || busy;
  if (file) {
    renderActiveMeta();
    renderTiles();
    renderEstimate();
    renderRows();
  }
  syncMode();
  syncTabs();
}

function refreshChoose() {
  syncActive();
  if (!file) {
    renderEmpty();
    return;
  }
  renderActiveMeta();
  renderTiles();
  // Measured result bars survive while results exist; estimates otherwise.
  if (results.length) {
    tr.textContent = activeTarget();
    syncConvertBtn();
  } else {
    renderEstimate();
  }
  renderRows();
  syncMode();
  syncTabs();
  syncPageTheme();
}

function select(i, focus) {
  if (busy || !files[i]) return;
  clearResults();
  activeIndex = i;
  syncActive();
  renderActiveMeta();
  renderTiles();
  renderEstimate();
  [...fileGrid.children].forEach((li, j) => li.setAttribute("aria-selected", String(j === activeIndex)));
  if (focus && fileGrid.children[activeIndex]) fileGrid.children[activeIndex].focus();
  syncTabs();
  syncPageTheme();
}

function removeAt(i) {
  if (busy) return;
  const [rm] = files.splice(i, 1);
  if (rm) {
    dimsCache.delete(rm.hid);
    dimsPending.delete(rm.hid);
    durCache.delete(rm.hid);
    durPending.delete(rm.hid);
  }
  if (rm && rm.url) {
    try {
      URL.revokeObjectURL(rm.url);
    } catch {
      // ignore
    }
  }
  clearResults();
  if (activeIndex >= files.length) activeIndex = Math.max(0, files.length - 1);
  syncActive();
  if (!file) {
    renderEmpty();
    return;
  }
  renderGrid();
}

function describeRejection(picked) {
  const kind = stubKind(picked);
  const seenType = String((picked && picked.type) || "") || "unknown type";
  const seenExt = extOf(picked && picked.name) || "no extension";
  if (kind === "video" || kind === "document")
    return `${picked.name}: noted — ${kind} conversion is coming soon, listed for now. (saw ${seenType} / ${seenExt})`;
  return `${picked.name}: unsupported file (saw ${seenType} / ${seenExt}) — images (PNG / JPG / SVG / WEBP / HEIC) or audio (MP3 / WAV / FLAC / AAC / OGG / M4A) only.`;
}

function entryDefault(family) {
  let t = defaultTargetFor(family, target);
  if (family === "image") {
    if (t === "WEBP" && !supportsWebp()) t = "JPG";
    if (t === "HEIC") t = "JPG";
    return t;
  }
  if (family === "audio") {
    if (!AUDIO_CONVERTIBLE_TARGETS.includes(t)) t = "MP3";
    if (!supportsAudioTarget(t)) {
      if (supportsAudioTarget("MP3")) t = "MP3";
      else t = "WAV";
    }
    return t;
  }
  if (t === "WEBP" && !supportsWebp()) t = "JPG";
  return t;
}

function addFiles(list) {
  const incoming = [...list];
  if (!incoming.length || busy) return;
  const rejected = [];
  let added = 0;
  for (const picked of incoming) {
    if (files.length >= MAX_FILES) {
      rejected.push(`${picked.name}: queue is full (max ${MAX_FILES}).`);
      continue;
    }
    if (!isKnown(picked)) {
      const reason = describeRejection(picked);
      try {
        console.debug("[chameleon] rejected", { name: picked.name, type: picked.type, size: picked.size, reason });
      } catch {
        // ignore
      }
      rejected.push(reason);
      continue;
    }
    const hid = "h" + Date.now().toString(36) + "-" + seq++;
    const family = familyOf(picked);
    files.push({
      hid,
      blob: picked,
      name: picked.name,
      size: picked.size,
      type: picked.type,
      url: thumbUrl(picked, picked.type, picked.name),
      family,
      target: entryDefault(family),
    });
    try {
      console.debug("[chameleon] staged", { name: picked.name, type: picked.type, size: picked.size, family });
    } catch {
      // ignore
    }
    added++;
  }
  clearResults();
  if (added > 0 && files.length - added === 0) activeIndex = 0;
  if (activeIndex >= files.length) activeIndex = files.length - 1;
  syncActive();
  renderGrid();
  if (rejected.length) setStatus(rejected[0]);
  syncTabs();
}

function renderEmpty() {
  syncActive();
  singleCard.hidden = true;
  fileGrid.innerHTML = "";
  fileGrid.hidden = true;
  fileGrid.classList.remove("grid");
  dropEmpty.hidden = false;
  toChoose.disabled = true;
  filerows.innerHTML = "";
  filerows.hidden = true;
  showBlk.hidden = true;
  document.title = "Chameleon — Convert";
  h1txt.dataset.text = "Convert a file";
  h1txt.textContent = "Convert a file";
  activeTab = 1;
  viewDrop.hidden = false;
  viewChoose.hidden = true;
  viewDl.hidden = true;
  syncMode();
  syncTabs();
}

function clearResults() {
  if (!results.length) {
    syncTabs();
    return;
  }
  results.forEach((r) => {
    try {
      URL.revokeObjectURL(r.url);
    } catch {
      // ignore
    }
  });
  results = [];
  resultsEl.innerHTML = "";
  resultsEl.hidden = true;
  dlAll.hidden = true;
  if (file) renderEstimate();
  syncTabs();
}

function setProgress(pct, label) {
  pbar.style.width = pct + "%";
  pbarwrap.setAttribute("aria-valuenow", String(pct));
  plabel.textContent = label;
}

// --- tab + view events ---
tab1.addEventListener("click", () => goTab(1));
tab2.addEventListener("click", () => goTab(2));
tab3.addEventListener("click", () => goTab(3));
toChoose.addEventListener("click", () => goTab(2));
backSettings.addEventListener("click", () => goTab(2));
againBtn.addEventListener("click", () => {
  goTab(1);
  changeInput.click();
});

modeAll.addEventListener("click", () => {
  if (busy || !bulkAvailable()) return;
  mode = "bulk";
  // One conversion for all: every file follows the global target when it fits.
  const fam = files.length ? files[0].family : null;
  files.forEach((f) => {
    if (f.family === "image" && REAL_TARGETS.includes(target)) f.target = target;
    else if (f.family === "audio" && REAL_AUDIO_TARGETS.includes(target)) f.target = target;
    else if (f.family === fam) f.target = entryDefault(f.family);
  });
  clearResults();
  refreshChoose();
});
modeManual.addEventListener("click", () => {
  if (busy || !files.length) return;
  mode = "manual";
  clearResults();
  refreshChoose();
});

fileGrid.addEventListener("click", (e) => {
  if (e.target.closest(".remove-btn")) return;
  const li = e.target.closest("[data-index]");
  if (li) select(+li.dataset.index, false);
});
fileGrid.addEventListener("keydown", (e) => {
  const li = e.target.closest("[data-index]");
  if (!li) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    select(+li.dataset.index, false);
  }
});

filerows.addEventListener("click", (e) => {
  if (e.target.closest("select")) return;
  const li = e.target.closest("[data-index]");
  if (li) select(+li.dataset.index, false);
});

function renderGridSubs() {
  fileGrid.querySelectorAll(".meta span").forEach((sub, j) => {
    const entry = files[j];
    if (entry) sub.textContent = `${fmtSize(entry.size)} → ${entry.target}`;
  });
}

q.addEventListener("input", () => {
  if (!file || busy) return;
  if (results.length) clearResults();
  renderEstimate();
  if (isAudioEntry(file)) renderRows();
});

changeBtn.addEventListener("click", () => changeInput.click());
emptyBrowseBtn.addEventListener("click", () => changeInput.click());
convertDrop.addEventListener("click", (event) => {
  if (!event.target.closest("button,input")) changeInput.click();
});
convertDrop.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    changeInput.click();
  }
});
changeInput.addEventListener("change", () => {
  if (changeInput.files && changeInput.files.length) addFiles(changeInput.files);
  changeInput.value = "";
});
let convertDragDepth = 0;
convertDrop.addEventListener("dragenter", (event) => {
  event.preventDefault();
  if (event.dataTransfer?.types.includes("Files")) {
    convertDragDepth++;
    convertDrop.classList.add("dragover");
  }
});
convertDrop.addEventListener("dragover", (event) => event.preventDefault());
convertDrop.addEventListener("dragleave", (event) => {
  event.preventDefault();
  if (--convertDragDepth <= 0) {
    convertDragDepth = 0;
    convertDrop.classList.remove("dragover");
  }
});
convertDrop.addEventListener("drop", (event) => {
  event.preventDefault();
  convertDragDepth = 0;
  convertDrop.classList.remove("dragover");
  if (event.dataTransfer?.files) addFiles(event.dataTransfer.files);
});

// --- conversion (every convertible file, sequentially) ---
btn.addEventListener("click", async () => {
  const jobs = files.filter(convertible);
  if (!jobs.length || busy) return;
  busy = true;
  clearResults();
  prog.hidden = false;
  setProgress(0, "Starting…");
  btn.disabled = true;
  toChoose.disabled = true;
  modeAll.disabled = true;
  modeManual.disabled = true;
  tiles.forEach((b) => (b.disabled = true));
  q.disabled = true;
  filerows.querySelectorAll("select").forEach((s) => (s.disabled = true));
  syncTabs();
  const quality = +q.value;
  const failed = [];

  try {
    for (let j = 0; j < jobs.length; j++) {
      const entry = jobs[j];
      const base = (j / jobs.length) * 100;
      const span = 100 / jobs.length;
      const tag = jobs.length > 1 ? ` (${j + 1} of ${jobs.length})` : "";
      setProgress(base + span * 0.08, `Decoding ${entry.name}…${tag}`);
      setStatus(`Converting ${entry.name} → ${entry.target}${tag}…`);
      try {
        let blob;
        let outNameFinal;
        if (isAudioEntry(entry)) {
          if (entry.target === "MP3") {
            try {
              await ensureLame();
            } catch {
              // MediaRecorder fallback covers it
            }
          }
          const decoded = await decodeAudio(entry.blob);
          setProgress(base + span * 0.35, `Encoding ${entry.name}…${tag}`);
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
          blob = await encodeAudio(decoded, entry.target, quality);
          // AudioBuffers are GC'd; close piste not needed. Release decode refs.
          try {
            decoded.getChannelData(0);
          } catch {
            // ignore
          }
          outNameFinal = outNameAudio(entry.name, entry.target);
        } else {
          const decoded = await decodeImage(entry.blob, entry.name);
          setProgress(base + span * 0.35, `Encoding ${entry.name}…${tag}`);
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
          blob = await encodeImage(decoded, entry.target, quality);
          if (decoded && decoded.close) {
            try {
              decoded.close();
            } catch {
              // ignore
            }
          }
          outNameFinal = outName(entry.name, entry.target);
        }
        const url = URL.createObjectURL(blob);
        results.push({
          entryName: entry.name,
          blob,
          url,
          thumb: entry.url,
          name: outNameFinal,
          size: blob.size,
          srcSize: entry.size,
          target: entry.target,
          quality,
        });
        setProgress(base + span, `Finished ${entry.name}${tag}`);
      } catch (err) {
        const code = err && err.message ? err.message : "decode-failed";
        let reason = "couldn't be read in this browser";
        if (code === "heic-unsupported")
          reason = "HEIC isn't decodable in this browser — try Safari or export to JPG first";
        else if (code === "webp-unsupported")
          reason = "WebP encoding isn't supported in this browser — try JPG";
        else if (code === "heic-output-unsupported") reason = "HEIC output isn't supported — pick another format";
        else if (code === "mp3-unsupported") reason = "MP3 encoding isn't supported in this browser — try WAV";
        else if (code === "ogg-unsupported") reason = "OGG encoding isn't supported in this browser — try WAV or MP3";
        else if (code === "flac-unsupported") reason = "FLAC encoding isn't supported in this browser — try WAV";
        else if (code === "aac-unsupported") reason = "AAC encoding isn't supported in this browser — try WAV or MP3";
        else if (code === "m4a-unsupported") reason = "M4A encoding isn't supported in this browser — try WAV or MP3";
        else if (code === "encode-unsupported" || code === "encode-timeout")
          reason = `${entry.target} encoding isn't supported in this browser — try WAV`;
        else if (code === "webaudio-unsupported") reason = "audio decoding isn't supported in this browser";
        try {
          console.debug("[chameleon] convert failed", { name: entry.name, target: entry.target, code, reason });
        } catch {
          // ignore
        }
        failed.push({ name: entry.name, reason });
        setProgress(base + span, `Skipped ${entry.name}${tag}`);
      }
    }
    prog.hidden = true;
    busy = false;
    syncTileAvailability();
    q.disabled = false;
    toChoose.disabled = false;
    renderResults(failed);
    renderMeasured();
    refreshChoose();
    if (failed.length) {
      setStatus(
        failed.length === 1
          ? `Couldn't convert ${failed[0].name}: ${failed[0].reason}`
          : `${failed.length} files couldn't be converted — see Download tab for reasons.`
      );
    }
    goTab(3);
    // Best-effort auto-download of every result; blockers fall back to buttons.
    for (const r of results) {
      try {
        const a = document.createElement("a");
        a.href = r.url;
        a.download = r.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        await new Promise((r2) => setTimeout(r2, 250));
      } catch {
        // per-file buttons cover it
      }
    }
  } catch {
    prog.hidden = true;
    busy = false;
    syncTileAvailability();
    q.disabled = false;
    toChoose.disabled = files.length === 0;
    renderEstimate();
    refreshChoose();
    setStatus("Conversion failed — try smaller files or a different format.");
  }
});

dlAll.addEventListener("click", async () => {
  for (const r of results) {
    const a = document.createElement("a");
    a.href = r.url;
    a.download = r.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r2) => setTimeout(r2, 250));
  }
});

// --- init: load staged files first so scramble measures the final H1 ---
async function loadStaged() {
  const params = new URLSearchParams(location.search);
  const paramTarget = (params.get("target") || stagedTargetFallback() || "").toUpperCase();
  if (paramTarget) target = paramTarget;
  let rows = [];
  try {
    rows = await Promise.race([getStaged(), new Promise((resolve) => setTimeout(() => resolve([]), 1500))]);
  } catch {
    rows = [];
  }
  const usable = rows.filter((r) => r && r.blob && isKnown({ name: r.name, type: r.type }));
  extraCount = Math.max(0, rows.length - Math.min(usable.length, MAX_FILES));
  usable.slice(0, MAX_FILES).forEach((r) => {
    const family = familyOf({ name: r.name, type: r.type });
    files.push({
      hid: r.id || "h" + seq++,
      blob: r.blob,
      name: r.name,
      size: r.size,
      type: r.type,
      url: thumbUrl(r.blob, r.type, r.name),
      family,
      target: entryDefault(family),
    });
  });
  if (!tiles.some((b) => b.dataset.f === target)) {
    // Keep staged targets when they belong to the other family; renderTiles
    // validates per-family below.
    const up = String(target || "").toUpperCase();
    if (![...REAL_TARGETS, ...REAL_AUDIO_TARGETS, "HEIC"].includes(up)) target = "WEBP";
  }
}

await loadStaged();
// Per-family fallbacks mirror the photo WEBP/HEIC pattern.
if (!supportsWebp()) {
  if (target === "WEBP") target = "JPG";
  files.forEach((f) => {
    if (f.family === "image" && f.target === "WEBP") f.target = "JPG";
  });
}
// HEIC is input-only — never a valid output target.
if (target === "HEIC") target = "JPG";
files.forEach((f) => {
  if (f.family === "image" && f.target === "HEIC") f.target = "JPG";
});
files.forEach((f) => {
  if (f.family === "audio" && !supportsAudioTarget(f.target)) {
    f.target = supportsAudioTarget("MP3") ? "MP3" : "WAV";
  }
});
if (target && files.length === 0) {
  if (![...REAL_TARGETS, ...REAL_AUDIO_TARGETS].includes(target)) target = "WEBP";
}
setFormatTheme(target);
if (files.length) {
  syncActive();
  renderGrid();
  activeTab = 2;
  viewDrop.hidden = true;
  viewChoose.hidden = false;
  viewDl.hidden = true;
  syncTabs();
  const mixed = !bulkAvailable();
  if (mixed) mode = "manual";
  syncMode();
  setFormatTheme(activeTarget());
  setStatus("");
} else {
  renderEmpty();
}
initScramble();

addEventListener("beforeunload", () => {
  results.forEach((r) => {
    try {
      URL.revokeObjectURL(r.url);
    } catch {
      // ignore
    }
  });
});

// Overscroll paint (kept from shell).
const root = document.documentElement;
const paintEdge = () => {
  const max = document.body.scrollHeight - window.innerHeight;
  root.dataset.edge = max > 0 && window.scrollY >= max - 200 ? "bottom" : "top";
};
addEventListener("scroll", () => requestAnimationFrame(paintEdge), { passive: true });
addEventListener("resize", paintEdge);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(paintEdge);
if ("ResizeObserver" in window) new ResizeObserver(paintEdge).observe(document.body);
paintEdge();
