/* Chameleon — convert page: merged Choose + Convert, progress, download view.
   Drop tab holds up to MAX_FILES uploads (1-2: long banners, 3+: grid).
   Choose tab lists files with a SHOW toggle: ALL FILES applies one target to
   everything (single family only); CUSTOM gives each file its own target.
   Mixed families lock bulk and force custom. Unrecognised files are rejected
   at add; convertible files convert. Convert runs every convertible file
   sequentially; results list with per-file Download + Download all.
   Everything stays on-device. */

import { initScramble } from "./scramble.js";
import { getStaged, stagedTargetFallback, clearStaged } from "./store.js";
import {
  isSupported,
  fmtSize,
  extOf,
  familyOf,
  targetsFor,
  defaultTargetFor,
  CONVERTIBLE_TARGETS,
  AUDIO_CONVERTIBLE_TARGETS,
  DOC_CONVERTIBLE_TARGETS,
  VIDEO_CONVERTIBLE_TARGETS,
  shortName,
  MAX_FILES,
  limitFor,
} from "./convert.js?v=4";
import { decodeImage, encodeImage, supportsWebp, getImageDimensions, outName } from "./encode.js";
import {
  decodeDoc,
  encodeDoc,
  supportsDocTarget,
  ensurePdf,
  outNameDoc,
  DOC_LOSSLESS_TARGETS,
} from "./encode-doc.js?v=1";
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
import {
  decodeVideo,
  encodeVideo,
  closeVideo,
  supportsVideoTarget,
  ensureFfmpeg,
  getVideoMetadata,
  fmtVideoDuration,
  videoQualityLabel,
  outNameVideo,
} from "./encode-video.js?v=3";

const GRID_FROM = 3; // < GRID_FROM files: long banner; >= GRID_FROM: grid
const REAL_TARGETS = ["PNG", "JPG", "SVG", "WEBP"];
const REAL_AUDIO_TARGETS = ["MP3", "WAV", "OGG", "AAC", "M4A"];
const REAL_DOC_TARGETS = ["TXT", "MD", "RTF", "PDF", "DOCX", "EPUB"];
const REAL_VIDEO_TARGETS = ["MP4", "WEBM", "MOV", "MKV", "AVI"];
// Shell estimate weights (used until a real conversion measures bytes).
// SVG wraps a PNG raster as base64, so it runs larger than the source.
const WEIGHTS = { PNG: 1.0, JPG: 0.45, SVG: 1.35, WEBP: 0.35 };
// Audio weights mirror the photo approach: lossy shrinks, WAV grows to PCM.
// Quality scales lossy targets only (WAV ignores it, like PNG).
const AUDIO_WEIGHTS = { MP3: 0.32, AAC: 0.3, OGG: 0.27, M4A: 0.3, WAV: 1.4 };
// Document weights: markup/container overhead per target. Quality scales
// PDF only (embedded-image fidelity); pure-text targets ignore it.
const DOC_WEIGHTS = { TXT: 0.9, MD: 1.0, RTF: 1.25, PDF: 1.1, DOCX: 1.15, EPUB: 1.2 };
// Video weights: container overhead per target. Quality scales every video
// target via the resolution rung (480p–4K cap); higher rungs ≈ larger files.
const VIDEO_WEIGHTS = { MP4: 0.9, WEBM: 0.7, MOV: 1.0, MKV: 0.95, AVI: 1.25 };
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
const singleAudio = $("single-audio");
const singleVideo = $("single-video");
const singlePlayer = $("single-player");
const ppToggle = $("pp-toggle");
const ppCur = $("pp-cur");
const ppSeek = $("pp-seek");
const ppDur = $("pp-dur");
const ppMute = $("pp-mute");
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
let activeTab = 1;
let results = []; // { entryName, blob, url, name, size, target, quality }
let seq = 0;
const dimsCache = new Map(); // hid -> { w, h } | null (null = undecodable here)
const dimsPending = new Set(); // hids with an in-flight dimension decode
const durCache = new Map(); // hid -> seconds | null
const durPending = new Set();
const vidCache = new Map(); // hid -> { w, h, duration } | null
const vidPending = new Set();
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
    mp3: "mp3", wav: "wav", ogg: "ogg", aac: "aac", m4a: "m4a",
    txt: "txt", md: "md", rtf: "rtf", pdf: "pdf", docx: "docx", epub: "epub",
    mp4: "mp4", webm: "webm", mov: "mov", mkv: "mkv", avi: "avi",
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
  if (entry.family === "document") return DOC_CONVERTIBLE_TARGETS.includes(entry.target);
  if (entry.family === "video") return VIDEO_CONVERTIBLE_TARGETS.includes(entry.target);
  return false;
}

function isAudioEntry(entry) {
  return !!entry && entry.family === "audio";
}

function isDocEntry(entry) {
  return !!entry && entry.family === "document";
}

function isVideoEntry(entry) {
  return !!entry && entry.family === "video";
}

/** Quality slider is meaningless for pure-text doc targets (mirrors lossless). */
function docIgnoresQuality(entry) {
  return isDocEntry(entry) && DOC_LOSSLESS_TARGETS.includes(entry.target);
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
  modeAll.innerHTML = `All<span class="seg-extra"> files</span> &middot; ${files.length}`;
  modeAll.title = `All files · ${files.length}`;
  modeNote.hidden = ok;
  if (!ok && files.length) {
    modeNote.textContent = "Mixed file types — bulk is locked. Set each file with Custom.";
    modeNote.hidden = false;
  }
  // Tiles/quality drive bulk conversion; hide them when bulk can't act.
  const showBulkCtrls = mode === "bulk" && ok && files.some((f) => convertible(f) || f.family === "image" || f.family === "audio" || f.family === "document" || f.family === "video");
  tilesBlk.hidden = !showBulkCtrls && !(mode === "manual" && files.length === 1);
  // Text has no quality axis — hide the slider when every convertible job
  // ignores it (mirrors how lossless targets ignore quality).
  const jobs = files.filter(convertible);
  qBlk.hidden = jobs.length === 0 || jobs.every(docIgnoresQuality);
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
    [".mp3", ".wav", ".aac", ".ogg", ".oga", ".opus", ".m4a", ".weba", ".3gp"].some((e) => n.endsWith(e));
  const isVideo =
    t.startsWith("video/") ||
    [".mp4", ".mov", ".webm", ".mkv", ".avi"].some((e) => n.endsWith(e));
  if (!isImg && !isAudio && !isVideo) return null;
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
  if (isDocEntry(entry)) {
    const w = DOC_WEIGHTS[entry.target] || 1.0;
    // Only PDF output has a fidelity axis (embedded images); text ignores it.
    const qf = entry.target === "PDF" ? 0.6 + (0.6 * v) / 100 : 1;
    return ((srcKB * w) / BASE) * qf;
  }
  if (isVideoEntry(entry)) {
    const w = VIDEO_WEIGHTS[entry.target] || 0.9;
    // Resolution rung: 480p shrinks a lot, 4K keeps (or grows) the source.
    const qf = 0.35 + (1.85 * v) / 100;
    return ((srcKB * w) / BASE) * qf;
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
      if (fam === "document" && REAL_DOC_TARGETS.includes(target)) f.target = target;
      if (fam === "video" && REAL_VIDEO_TARGETS.includes(target)) f.target = target;
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
  const defs = fam === "audio" ? REAL_AUDIO_TARGETS : fam === "document" ? REAL_DOC_TARGETS : fam === "video" ? REAL_VIDEO_TARGETS : [...REAL_TARGETS, "HEIC"];
  // Scale the grid to the tile count so every family fits one row
  // (documents render six tiles where the CSS default holds five).
  // Small screens keep the CSS 3-column wrap — six cramped tiles help nobody.
  try {
    const narrow = window.matchMedia && window.matchMedia("(max-width:560px)").matches;
    tilesEl.style.gridTemplateColumns = narrow ? "" : `repeat(${defs.length},minmax(0,1fr))`;
  } catch {
    // CSS default covers it
  }
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

// Keep tile columns in lockstep with the stylesheet across resizes and
// rotations (same 560/700px cutoffs as renderTiles and style.css).
try {
  const mqNarrow = window.matchMedia && window.matchMedia("(max-width:560px)");
  const mqMid = window.matchMedia && window.matchMedia("(max-width:700px)");
  const onBpChange = () => {
    try {
      renderTiles();
    } catch {
      // next render covers it
    }
  };
  if (mqNarrow && mqNarrow.addEventListener) {
    mqNarrow.addEventListener("change", onBpChange);
    if (mqMid) mqMid.addEventListener("change", onBpChange);
  }
} catch {
  // static render covers it
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
    return;
  }
  if (fam === "document") {
    tiles.forEach((b) => {
      if (!supportsDocTarget(b.dataset.f)) {
        b.disabled = true;
        b.title = `${b.dataset.f} needs ZIP support this browser lacks — TXT works everywhere.`;
        labelTile(b, "NO SUPPORT");
      }
    });
    return;
  }
  if (fam === "video") {
    tiles.forEach((b) => {
      if (!supportsVideoTarget(b.dataset.f)) {
        b.disabled = true;
        const needsVendor = ["MOV", "MKV", "AVI"].includes(b.dataset.f);
        if (needsVendor) {
          // Accepted as input, but this browser can't *produce* the
          // container without the optional vendor build — same INPUT ONLY
          // pattern as HEIC. (Input is always attempted; an unreadable
          // file surfaces an honest error at convert time.)
          b.title = `${b.dataset.f} is input-only here — drop one in and convert it to ${supportsVideoTarget("MP4") ? "MP4" : "WEBM"}. Producing ${b.dataset.f} files needs the optional local encoder (vendored ffmpeg).`;
          labelTile(b, "INPUT ONLY");
        } else {
          b.title = `${b.dataset.f} encoding isn't supported in this browser — try ${supportsVideoTarget("MP4") ? "MP4" : "WEBM"}.`;
          labelTile(b, "NO SUPPORT");
        }
      }
    });
  }
}

function syncConvertBtn() {
  const n = convertibleCount();
  btn.disabled = n === 0 || busy;
  const multi = files.length > 1;
  btn.innerHTML =
    multi ? `Convert ${n} file${n === 1 ? "" : "s"} &rarr;` : `Convert<span class="btn-extra"> to</span> ${activeTarget()} &rarr;`;
  btn.setAttribute("aria-label", multi ? `Convert ${n} file${n === 1 ? "" : "s"}` : `Convert to ${activeTarget()}`);
  btn.title =
    n === 0 ? "Nothing convertible yet — images convert to PNG / JPG / SVG / WEBP, audio to MP3 / WAV / OGG / AAC / M4A, documents to TXT / MD / RTF / PDF / DOCX / EPUB, video to MP4 / WEBM / MOV / MKV / AVI." : "";
}

function renderEstimate() {
  const at = activeTarget();
  const v = +q.value;
  const audioActive = !!file && isAudioEntry(file);
  const videoActive = !!file && isVideoEntry(file);
  qv.textContent =
    audioActive && !LOSSLESS_TARGETS.includes(at)
      ? `${v}% · ${bitrateLabel(v, at)}`
      : videoActive
        ? `${v}% · ${videoQualityLabel(v)}`
        : v + "%";
  qr.textContent =
    audioActive && !LOSSLESS_TARGETS.includes(at)
      ? `${v} · ${bitrateLabel(v, at)}`
      : videoActive
        ? `${v} · ${videoQualityLabel(v)}`
        : v;
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
  const lossyAudio = results.filter((r) => AUDIO_CONVERTIBLE_TARGETS.includes(r.target) && !LOSSLESS_TARGETS.includes(r.target));
  const qSuffix = lossyAudio.length
    ? `quality ${q.value} · ${[...new Set(lossyAudio.map((r) => bitrateLabel(+q.value, r.target)))].join(" / ")}`
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
    nm.textContent = shortName(r.name);
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
    nm.textContent = shortName(f.name);
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

/* Custom audio preview player: the <audio> element is the hidden engine,
   these controls drive it. Built once, bound once; renderSingleCard only
   swaps the loaded URL (never rebuilds mid-playback). */
let ppSrc = null;
let ppSeeking = false;

function ppFmt(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function ppPaint() {
  if (!singleAudio || !ppSeek) return;
  const d = singleAudio.duration;
  const ok = Number.isFinite(d) && d > 0;
  if (ppDur) ppDur.textContent = ok ? ppFmt(d) : "0:00";
  const c = singleAudio.currentTime || 0;
  if (ppCur) ppCur.textContent = ppFmt(c);
  if (!ppSeeking && ppSeek) {
    const pct = ok ? Math.min(100, Math.max(0, (c / d) * 100)) : 0;
    ppSeek.value = String(Math.round(pct * 10));
    ppSeek.style.setProperty("--fill", pct + "%");
  }
}

function ppSetIcon() {
  if (!ppToggle || !singleAudio) return;
  const playing = !singleAudio.paused && !singleAudio.ended;
  ppToggle.textContent = playing ? "❚❚" : "▶";
  ppToggle.setAttribute("aria-label", playing ? "Pause preview" : "Play preview");
}

function ppMutePaint() {
  if (!ppMute || !singleAudio) return;
  const muted = singleAudio.muted || singleAudio.volume === 0;
  ppMute.textContent = muted ? "MUTED" : "MUTE";
  ppMute.setAttribute("aria-pressed", String(muted));
  ppMute.setAttribute("aria-label", muted ? "Unmute preview" : "Mute preview");
}

/** Load a preview URL into the engine (no-op when unchanged). */
function ppLoad(url) {
  if (!singleAudio) return;
  if (ppSrc === (url || null)) return;
  ppSrc = url || null;
  try {
    singleAudio.pause();
  } catch {
    // ignore
  }
  try {
    if (ppSrc) singleAudio.src = ppSrc;
    else {
      singleAudio.removeAttribute("src");
      singleAudio.load();
    }
  } catch {
    // ignore
  }
  if (ppSeek) {
    ppSeek.value = "0";
    ppSeek.style.setProperty("--fill", "0%");
  }
  if (ppCur) ppCur.textContent = "0:00";
  if (ppDur) ppDur.textContent = "0:00";
  ppSetIcon();
  ppMutePaint();
}

function ppStop() {
  if (!singleAudio) return;
  try {
    singleAudio.pause();
  } catch {
    // ignore
  }
  ppLoad(null);
  if (singlePlayer) singlePlayer.hidden = true;
  ppSetIcon();
}

if (ppToggle && singleAudio) {
  ppToggle.addEventListener("click", async () => {
    if (!ppSrc) return;
    try {
      if (singleAudio.paused) await singleAudio.play();
      else singleAudio.pause();
    } catch {
      // autoplay policy or revoked URL — icon stays on play
    }
    ppSetIcon();
  });
  singleAudio.addEventListener("play", ppSetIcon);
  singleAudio.addEventListener("pause", ppSetIcon);
  singleAudio.addEventListener("ended", ppSetIcon);
  singleAudio.addEventListener("timeupdate", ppPaint);
  singleAudio.addEventListener("loadedmetadata", ppPaint);
  singleAudio.addEventListener("durationchange", ppPaint);
}
if (ppSeek && singleAudio) {
  ppSeek.addEventListener("input", () => {
    ppSeeking = true;
    const pct = Number(ppSeek.value) / 10;
    ppSeek.style.setProperty("--fill", Math.min(100, Math.max(0, pct)) + "%");
    const d = singleAudio.duration;
    if (Number.isFinite(d) && d > 0) ppCur.textContent = ppFmt((pct / 100) * d);
  });
  ppSeek.addEventListener("change", () => {
    const d = singleAudio.duration;
    if (Number.isFinite(d) && d > 0) {
      try {
        singleAudio.currentTime = (Math.min(1000, Math.max(0, Number(ppSeek.value))) / 1000) * d;
      } catch {
        // ignore
      }
    }
    ppSeeking = false;
    ppPaint();
  });
}
if (ppMute && singleAudio) {
  ppMute.addEventListener("click", () => {
    try {
      singleAudio.muted = !singleAudio.muted;
      if (!singleAudio.muted && singleAudio.volume === 0) singleAudio.volume = 1;
    } catch {
      // ignore
    }
    ppMutePaint();
  });
}

/** Stop the single-card video preview and release its element state. */
function vidStop() {
  if (!singleVideo) return;
  try {
    singleVideo.pause();
  } catch {
    // ignore
  }
  try {
    singleVideo.removeAttribute("src");
    singleVideo.load();
  } catch {
    // ignore
  }
  singleVideo.hidden = true;
}

/** Large preview card: image thumb, audio player, muted video, or doc badge. */
function renderSingleCard() {
  const show = files.length === 1 && !!file && (file.family === "image" || file.family === "audio" || file.family === "document" || file.family === "video");
  singleCard.hidden = !show;
  if (!show) {
    ppStop();
    vidStop();
    return;
  }
  const entry = file;
  const thumbBox = singleImg.parentElement;
  singleName.textContent = shortName(entry.name);
  singleName.title = entry.name;
  const showAudio = entry.family === "audio";
  const showDoc = entry.family === "document";
  const showVideo = entry.family === "video";
  if (singlePlayer) singlePlayer.hidden = !showAudio;
  if (!showAudio) ppStop();
  if (!showVideo) vidStop();
  // Rebuild thumb so a previous HEIC fallback can't leak into the next file.
  thumbBox.textContent = "";
  if (showDoc) {
    singleImg.hidden = true;
    singleImg.removeAttribute("src");
    const badge = document.createElement("span");
    badge.className = "badge lg";
    badge.textContent = srcExtOf(entry.name);
    thumbBox.append(badge, singleImg);
  } else if (showAudio) {
    singleImg.hidden = true;
    singleImg.removeAttribute("src");
    if (singleVideo) singleVideo.hidden = true;
    const badge = document.createElement("span");
    badge.className = "badge lg";
    badge.textContent = srcExtOf(entry.name);
    thumbBox.append(badge, singleImg);
    if (singleVideo) thumbBox.appendChild(singleVideo);
    ppLoad(entry.url);
  } else if (showVideo) {
    // Muted inline preview (mirrors the audio player precedent): the
    // element is the preview engine, never autoplayed.
    singleImg.hidden = true;
    singleImg.removeAttribute("src");
    if (singleVideo) {
      singleVideo.hidden = false;
      if (entry.url && singleVideo.getAttribute("src") !== entry.url) {
        try {
          singleVideo.src = entry.url;
        } catch {
          // unreadable here — meta line still renders below
        }
      }
      thumbBox.append(singleVideo, singleImg);
    } else {
      const badge = document.createElement("span");
      badge.className = "badge lg";
      badge.textContent = srcExtOf(entry.name);
      thumbBox.append(badge, singleImg);
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
  if (showDoc) {
    // Documents show the ext badge plus format/size/target only — no text
    // excerpt. Excerpts dump raw file boilerplate into the card (a .txt of
    // scraped page copy reads as broken UI), and decoding here would pull
    // in the PDF reader just for a preview that nobody asked for.
    singleMeta.textContent = metaBase();
    return;
  }
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
  if (entry.family === "video") {
    const withRung = (base) => `${base} · ${videoQualityLabel(+q.value)}`;
    const paint = (m) => {
      if (!m) return withRung(metaBase());
      const dim = `${m.w} × ${m.h}px`;
      return m.duration ? withRung(`${metaBase()} · ${dim} · ${fmtVideoDuration(m.duration)}`) : withRung(`${metaBase()} · ${dim}`);
    };
    const cached = vidCache.get(entry.hid);
    if (cached || cached === null) {
      singleMeta.textContent = paint(cached);
    } else if (vidPending.has(entry.hid)) {
      singleMeta.textContent = `${metaBase()} · …`;
    } else {
      singleMeta.textContent = `${metaBase()} · …`;
      vidPending.add(entry.hid);
      const req = ++dimsReq;
      getVideoMetadata(entry.blob).then((m) => {
        vidPending.delete(entry.hid);
        vidCache.set(entry.hid, m || null);
        if (req !== dimsReq || !file || file.hid !== entry.hid || singleCard.hidden) return;
        singleMeta.textContent = paint(m);
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

/* Custom target dropdown (Custom mode rows): button + listbox popover that
   mirrors the old native select, including disabled options with reason tags.
   Only one popover is open at a time; Escape / outside click closes it. */
let openPick = null;

function closePick(refocus) {
  if (!openPick) return;
  const box = openPick;
  openPick = null;
  box.classList.remove("open");
  const b = box.querySelector(".pick-btn");
  const l = box.querySelector(".pick-list");
  if (b) b.setAttribute("aria-expanded", "false");
  if (l) l.hidden = true;
  if (refocus && b) {
    try {
      b.focus();
    } catch {
      // ignore
    }
  }
}

function focusPickOpt(pick, dir) {
  const opts = [...pick.querySelectorAll(".pick-opt:not(.dis)")];
  if (!opts.length) return;
  const cur = opts.indexOf(document.activeElement);
  const next = dir === "up" ? (cur <= 0 ? opts[opts.length - 1] : opts[cur - 1]) : cur < 0 ? opts[0] : opts[(cur + 1) % opts.length];
  try {
    next.focus();
  } catch {
    // ignore
  }
}

function togglePick(pick) {
  if (busy) return;
  if (openPick === pick) {
    closePick(false);
    return;
  }
  closePick(false);
  openPick = pick;
  pick.classList.add("open");
  const b = pick.querySelector(".pick-btn");
  const l = pick.querySelector(".pick-list");
  if (b) b.setAttribute("aria-expanded", "true");
  if (l) l.hidden = false;
}

function choosePickOpt(entry, v) {
  entry.target = v;
  closePick(false);
  clearResults();
  syncActive();
  syncTiles();
  renderEstimate();
  syncConvertBtn();
  renderRows();
  renderGridSubs();
  syncPageTheme();
  try {
    const idx = files.indexOf(entry);
    const btn = idx >= 0 && filerows.querySelector(`[data-index="${idx}"] .pick-btn`);
    if (btn) btn.focus({ preventScroll: true });
  } catch {
    // focus is a nicety, never fatal
  }
}

document.addEventListener("click", () => closePick(false));

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
    nm.textContent = shortName(entry.name);
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
      const pick = document.createElement("div");
      pick.className = "pick";
      const pbtn = document.createElement("button");
      pbtn.className = "pick-btn";
      pbtn.type = "button";
      pbtn.setAttribute("aria-haspopup", "listbox");
      pbtn.setAttribute("aria-expanded", "false");
      pbtn.setAttribute("aria-label", "Target format for " + entry.name);
      pbtn.disabled = busy;
      const pval = document.createElement("span");
      pval.className = "pick-val";
      pval.textContent = entry.target;
      const pcaret = document.createElement("span");
      pcaret.className = "pick-caret";
      pcaret.textContent = "▾";
      pcaret.setAttribute("aria-hidden", "true");
      pbtn.append(pval, pcaret);
      const plist = document.createElement("ul");
      plist.className = "pick-list";
      plist.setAttribute("role", "listbox");
      plist.setAttribute("aria-label", "Target format for " + entry.name);
      plist.hidden = true;
      targetsFor(entry.family).forEach((opt) => {
        const unsupportedAudio = entry.family === "audio" && !opt.soon && !supportsAudioTarget(opt.v);
        const unsupportedDoc = entry.family === "document" && !opt.soon && !supportsDocTarget(opt.v);
        const unsupportedVideo = entry.family === "video" && !opt.soon && !supportsVideoTarget(opt.v);
        const inputOnlyVideo =
          unsupportedVideo && ["MOV", "MKV", "AVI"].includes(opt.v);
        const disabled = opt.soon || unsupportedAudio || unsupportedDoc || unsupportedVideo;
        const reason = opt.soon ? (opt.label || "soon").toUpperCase() : inputOnlyVideo ? "INPUT ONLY" : disabled ? "NO SUPPORT" : "";
        const item = document.createElement("li");
        item.className = "pick-opt" + (disabled ? " dis" : "") + (opt.v === entry.target ? " sel" : "");
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(opt.v === entry.target));
        item.tabIndex = -1;
        if (disabled) item.setAttribute("aria-disabled", "true");
        else item.dataset.v = opt.v;
        const lab = document.createElement("span");
        lab.textContent = opt.v;
        item.append(lab);
        if (reason) {
          const tag = document.createElement("small");
          tag.className = "tile-tag";
          tag.setAttribute("aria-hidden", "true");
          tag.textContent = reason;
          item.append(tag);
        }
        if (!disabled) {
          const v = opt.v;
          item.addEventListener("click", (e) => {
            e.stopPropagation();
            choosePickOpt(entry, v);
          });
          item.addEventListener("keydown", (e) => {
            const box = e.target.closest(".pick");
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              choosePickOpt(entry, v);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              closePick(true);
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              e.stopPropagation();
              if (box) focusPickOpt(box, e.key === "ArrowUp" ? "up" : "down");
            } else if (e.key === "Tab") {
              closePick(false);
            }
          });
        }
        plist.append(item);
      });
      pbtn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePick(pick);
        if (openPick === pick) {
          const sel = pick.querySelector(".pick-opt.sel:not(.dis)") || pick.querySelector(".pick-opt:not(.dis)");
          if (sel) {
            try {
              sel.focus();
            } catch {
              // ignore
            }
          }
        }
      });
      pbtn.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          if (openPick !== pick) togglePick(pick);
          focusPickOpt(pick, "down");
        } else if (e.key === "Escape") {
          closePick(false);
        }
      });
      pick.addEventListener("click", (e) => e.stopPropagation());
      pick.append(pbtn, plist);
      li.append(pick);
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
  src.textContent = shortName(file.name);
  src.title = file.name;
  sz.textContent = fmtSize(file.size);
  origLabel.textContent = srcExt + " · Original";
  origSize.textContent = fmtSize(file.size);
  toChoose.innerHTML = "Continue &rarr;";
  toChoose.title = "";
  const multi = files.length > 1;
  const h1 = multi ? "Convert your files" : "Convert your " + srcExt;
  document.title = multi ? "Chameleon — Convert files" : "Chameleon — Convert a file";
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
    if (entry.family === "audio" || entry.family === "video") {
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
    name.textContent = shortName(entry.name);
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
  if (changeBtn) changeBtn.hidden = files.length === 0;
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
  renderGridSubs();
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
  renderRows();
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
    vidCache.delete(rm.hid);
    vidPending.delete(rm.hid);
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
  const seenType = String((picked && picked.type) || "") || "unknown type";
  const seenExt = extOf(picked && picked.name) || "no extension";
  void kind;
  return `${picked.name}: unsupported file (saw ${seenType} / ${seenExt}) — images (PNG / JPG / SVG / WEBP / HEIC), audio (MP3 / WAV / OGG / AAC / M4A), video (MP4 / WEBM / MOV / MKV / AVI) or documents (TXT / MD / RTF / PDF / DOCX / EPUB) only.`;
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
  if (family === "document") {
    if (!DOC_CONVERTIBLE_TARGETS.includes(t)) t = "PDF";
    if (!supportsDocTarget(t)) {
      if (supportsDocTarget("PDF")) t = "PDF";
      else t = "TXT";
    }
    return t;
  }
  if (family === "video") {
    if (!VIDEO_CONVERTIBLE_TARGETS.includes(t)) t = "MP4";
    // Prefer MP4, fall back to WEBM (never a dead default).
    if (!supportsVideoTarget(t)) {
      if (supportsVideoTarget("MP4")) t = "MP4";
      else if (supportsVideoTarget("WEBM")) t = "WEBM";
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
    if (!isSupported(picked) || picked.size > limitFor(picked)) {
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
  if (changeBtn) changeBtn.hidden = true;
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
    syncConvertBtn();
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
  syncConvertBtn();
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
    else if (f.family === "document" && REAL_DOC_TARGETS.includes(target)) f.target = target;
    else if (f.family === "video" && REAL_VIDEO_TARGETS.includes(target)) f.target = target;
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
  if (e.target.closest(".pick")) return;
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
  // Live, text-only estimate — no DOM rebuilds, so badges/tiles never flicker.
  renderEstimate();
});
q.addEventListener("change", () => {
  if (!file || busy) return;
  // Commit row + preview-card badges once per gesture (release / keypress).
  if (isAudioEntry(file)) renderRows();
  if (isVideoEntry(file)) renderSingleCard();
});

if (changeBtn) changeBtn.addEventListener("click", () => changeInput.click());
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

// Sample files (bar beneath the drop zone) — same assets as home.
const SAMPLES = {
  image: { url: "assets/samples/sample-image.jpg", name: "sample-image.jpg", type: "image/jpeg" },
  video: { url: "assets/samples/sample-video.mp4", name: "sample-video.mp4", type: "video/mp4" },
};
async function loadSample(kind, btn) {
  const def = SAMPLES[kind];
  if (!def || !btn || btn.disabled) return;
  btn.disabled = true;
  setStatus(`Loading ${def.name}…`);
  try {
    const res = await fetch(def.url);
    if (!res.ok) throw new Error("fetch failed");
    const blob = await res.blob();
    addFiles([new File([blob], def.name, { type: blob.type || def.type })]);
  } catch {
    setStatus("Sample couldn't load — check your connection and try again.");
  } finally {
    btn.disabled = false;
  }
}
document.getElementById("sample-bar")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-sample]");
  if (!btn) return;
  loadSample(btn.dataset.sample, btn);
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
  filerows.querySelectorAll(".pick-btn").forEach((s) => (s.disabled = true));
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
        if (isDocEntry(entry)) {
          const decoded = await decodeDoc(entry.blob, entry.name, (stage) => {
            if (stage === "ocr") setProgress(base + span * 0.15, `Reading scanned pages in ${entry.name}…${tag}`);
          });
          setProgress(base + span * 0.35, `Encoding ${entry.name}…${tag}`);
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
          blob = await encodeDoc(decoded.model, entry.target, quality);
          outNameFinal = outNameDoc(entry.name, entry.target);
        } else if (isVideoEntry(entry)) {
          if (["MOV", "MKV", "AVI"].includes(entry.target)) {
            // Optional vendored encoder: loads on demand, never preloaded.
            setProgress(base + span * 0.12, `Loading optional encoder for ${entry.target}…${tag}`);
            try {
              await ensureFfmpeg();
            } catch {
              // encodeVideo() surfaces the honest code below
            }
          }
          const decoded = await decodeVideo(entry.blob);
          setProgress(base + span * 0.35, `Encoding ${entry.name}…${tag}`);
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
          try {
            blob = await encodeVideo(decoded, entry.target, quality, (p) => {
              try {
                setProgress(base + span * (0.35 + 0.55 * (p || 0)), `Encoding ${entry.name}…${tag}`);
              } catch {
                // progress is best-effort
              }
            });
          } finally {
            closeVideo(decoded);
          }
          outNameFinal = outNameVideo(entry.name, entry.target);
        } else if (isAudioEntry(entry)) {
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
          // AudioBuffers are GC'd once decodeAudio's context is closed — nothing to release here.
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
        let reason;
        if (code === "unsupported-target") reason = `${entry.target} isn't a supported output here — pick another format`;
        else if (code === "no-toblob") reason = "canvas export isn't available in this browser — try another browser";
        else if (code === "no-2d-context") reason = "canvas 2D isn't available in this browser — try another browser";
        else if (code === "encode-failed") reason = `${entry.target} encoding failed — try again or pick another format`;
        else if (code === "ffmpeg-api-unknown") reason = "optional video encoder has an unknown API — try MP4 or WEBM";
        else if (code === "xml-corrupt") reason = "couldn't be read — the file's XML looks damaged";
        else if (code === "zip-unsupported-method") reason = `${entry.target} uses a ZIP method this browser can't write — try TXT or PDF`;
        else reason = "couldn't be read in this browser";
        if (code === "heic-unsupported")
          reason = "HEIC isn't decodable in this browser — try Safari or export to JPG first";
        else if (code === "webp-unsupported")
          reason = "WebP encoding isn't supported in this browser — try JPG";
        else if (code === "heic-output-unsupported") reason = "HEIC output isn't supported — pick another format";
        else if (code === "mp3-unsupported") reason = "MP3 encoding isn't supported in this browser — try WAV";
        else if (code === "video-unsupported") reason = "couldn't be read as video in this browser — the file may use an unsupported codec";
        else if (code === "mp4-unsupported") reason = "MP4 encoding isn't supported in this browser — try WEBM";
        else if (code === "webm-unsupported") reason = "WEBM encoding isn't supported in this browser — try MP4";
        else if (code === "mov-unsupported") reason = "MOV needs the optional local encoder, which isn't loaded — try MP4 or WEBM";
        else if (code === "mkv-unsupported") reason = "MKV needs the optional local encoder, which isn't loaded — try MP4 or WEBM";
        else if (code === "avi-unsupported") reason = "AVI needs the optional local encoder, which isn't loaded — try MP4 or WEBM";
        else if (code === "ogg-unsupported") reason = "OGG encoding isn't supported in this browser — try WAV or MP3";
        else if (code === "aac-unsupported") reason = "AAC encoding isn't supported in this browser — try WAV or MP3";
        else if (code === "m4a-unsupported") reason = "M4A encoding isn't supported in this browser — try WAV or MP3";
        else if (code === "pdf-unsupported") reason = "PDF reading isn't available — the reader failed to load, try again";
        else if (code === "pdf-no-text") reason = "no extractable text — scanned PDF with nothing recognized";
        else if (code === "ocr-unsupported") reason = "scanned PDF needs the OCR engine, which couldn't load — try a text PDF";
        else if (code === "ocr-failed") reason = "couldn't read the scanned pages — try a text-based PDF";
        else if (code === "zip-unsupported") reason = `${entry.target} needs ZIP support this browser lacks — try TXT or PDF`;
        else if (code === "zip-encrypted") reason = "couldn't be read — encrypted container, remove the password first";
        else if (code === "zip-corrupt") reason = "couldn't be read — the container looks damaged";
        else if (code === "docx-corrupt" || code === "epub-corrupt" || code === "rtf-corrupt")
          reason = "couldn't be read — the file may be damaged";
        else if (code === "docx-no-text" || code === "epub-no-text")
          reason = "no convertible text found in the file";
        else if (code === "encode-unsupported" || code === "encode-timeout")
          reason =
            code === "encode-timeout" && isVideoEntry(entry)
              ? "timed out while recording — try a shorter clip or a lower quality rung"
              : isVideoEntry(entry)
                ? `${entry.target} encoding isn't supported in this browser — try ${supportsVideoTarget("MP4") ? "MP4" : "WEBM"}`
                : `${entry.target} encoding isn't supported in this browser — try WAV`;
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
// Staged files are only honoured when arriving from home with ?staged=1.
// Direct visits always start on the Drop tab; any stale staging is cleared
// so old files can't resurrect the Choose tab.
async function loadStaged() {
  const params = new URLSearchParams(location.search);
  const hasStagedFlag = params.get("staged") === "1";
  const paramTarget = (params.get("target") || stagedTargetFallback() || "").toUpperCase();
  if (paramTarget) target = paramTarget;
  let rows = [];
  if (hasStagedFlag) {
    try {
      rows = await Promise.race([getStaged(), new Promise((resolve) => setTimeout(() => resolve([]), 1500))]);
    } catch {
      rows = [];
    }
  } else {
    try {
      await clearStaged();
    } catch {
      // storage hygiene is best-effort
    }
  }
  const usable = rows.filter((r) => {
    if (!r || !r.blob || !isSupported({ name: r.name, type: r.type })) return false;
    const probe = { name: r.name, type: r.type };
    return (r.size || 0) <= limitFor(probe);
  });
  extraCount = Math.max(0, rows.length - Math.min(usable.length, MAX_FILES));
  if (extraCount > 0) {
    try {
      console.debug("[chameleon] staged truncated", { total: rows.length, usable: usable.length, extraCount });
    } catch {
      // ignore
    }
  }
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
    if (![...REAL_TARGETS, ...REAL_AUDIO_TARGETS, ...REAL_DOC_TARGETS, ...REAL_VIDEO_TARGETS, "HEIC"].includes(up)) target = "WEBP";
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
  if (f.family === "document" && !supportsDocTarget(f.target)) {
    f.target = supportsDocTarget("PDF") ? "PDF" : "TXT";
  }
  if (f.family === "video" && !supportsVideoTarget(f.target)) {
    f.target = supportsVideoTarget("MP4") ? "MP4" : supportsVideoTarget("WEBM") ? "WEBM" : "MP4";
  }
});
if (target && !supportsDocTarget(target) && REAL_DOC_TARGETS.includes(target)) target = "PDF";
if (target && !supportsVideoTarget(target) && REAL_VIDEO_TARGETS.includes(target)) {
  target = supportsVideoTarget("MP4") ? "MP4" : supportsVideoTarget("WEBM") ? "WEBM" : target;
}
if (target && files.length === 0) {
  if (![...REAL_TARGETS, ...REAL_AUDIO_TARGETS, ...REAL_DOC_TARGETS, ...REAL_VIDEO_TARGETS].includes(target)) target = "WEBP";
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
  setStatus(extraCount > 0 ? `Staged ${files.length} files — ${extraCount} skipped (limit ${MAX_FILES}).` : "");
} else {
  renderEmpty();
}
// Preload the vendored MP3 encoder so the MP3 tile enables wherever the
// browser lacks native MP3 recording. Targets are left alone — this only
// re-renders availability once LAME arrives.
try {
  ensureLame().then((ok) => {
    if (ok && !busy && files.some((f) => f.family === "audio")) {
      renderTiles();
      renderRows();
    }
  });
} catch {
  // MP3 stays on its fallback path
}
// Preload the vendored PDF reader when documents are staged so PDF text
// extraction doesn't wait on first convert.
// Tesseract is deliberately NOT preloaded (multi-MB OCR engine) — it loads
// on demand when a scanned-image PDF is detected.
try {
  if (files.some((f) => f.family === "document")) {
    ensurePdf().then(() => {
      if (!busy && files.some((f) => f.family === "document")) {
        renderTiles();
        renderRows();
      }
    });
  }
} catch {
  // PDF input falls back to honest error codes
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
