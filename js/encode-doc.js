/* Chameleon — local document decode/encode helpers (no build step).
   Shared model: { blocks: [...] } where a block is
     { t:"h", level, runs } | { t:"p", runs } |
     { t:"ul"|"ol", items: runs[][] } |
     { t:"table", rows: runs[][][] } |
     { t:"img", data: Uint8Array, mime, name, alt }
   and a run is { text, b, i }.
   Decode: TXT/MD/RTF hand-rolled; PDF via vendored pdf.js (text items,
     OCR fallback for scanned pages via vendored tesseract.js); DOCX/EPUB
     via hand-rolled ZIP (central-directory parse, deflate-raw streams).
   Encode: TXT/MD/RTF hand-rolled; PDF hand-rolled writer (same role as
     the WAV encoder); DOCX/EPUB via hand-rolled ZIP writer.
   Capability gating mirrors encode-audio.js supportsAudioTarget():
     supportsDocTarget() is false only where the browser lacks ZIP
     streams (DOCX/EPUB). PDF *input* needs the vendored lib; a missing
     lib surfaces an honest error code, never a dead click.
   Images ride along DOCX/EPUB/MD/RTF/PDF-output. PDF *input* is text
   only (embedded PDF images are not carried — see FAQ). Tables ride
   along everywhere; plain-text outputs flatten them with " | ".
   Everything stays on-device. */

export const DOC_MIME_FOR = {
  TXT: "text/plain",
  MD: "text/markdown",
  RTF: "application/rtf",
  PDF: "application/pdf",
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  EPUB: "application/epub+zip",
};

// Pure-text targets ignore the quality slider (mirrors PNG/WAV + FAQ copy).
export const DOC_LOSSLESS_TARGETS = ["TXT", "MD", "RTF", "DOCX", "EPUB"];

const PDF_LIB_URL = "../assets/vendor/pdf.min.mjs?v=1";
const PDF_WORKER_URL = "../assets/vendor/pdf.worker.min.mjs?v=1";
const TESS_SCRIPT_URL = "./assets/vendor/tesseract.min.js?v=1";
// Worker/core/lang URLs must be ABSOLUTE: the OCR worker resolves them
// against its own script URL, so page-relative "./assets/…" would double
// up to /assets/vendor/assets/vendor/… and 404. Absolute same-origin
// URLs work from every context.
function tessVendorBase() {
  try {
    return new URL("./assets/vendor/", document.baseURI).href.replace(/\/$/, "");
  } catch {
    return "./assets/vendor";
  }
}

/* ---------------- capabilities ---------------- */

/** Runtime check: ZIP streams for DOCX/EPUB containers. */
export function hasZip() {
  try {
    return typeof CompressionStream === "function" && typeof DecompressionStream === "function";
  } catch {
    return false;
  }
}

/** Runtime check: can this browser encode this document target right now? */
export function supportsDocTarget(target) {
  const t = String(target || "").toUpperCase();
  if (t === "TXT" || t === "MD" || t === "RTF" || t === "PDF") return true;
  if (t === "DOCX" || t === "EPUB") return hasZip();
  return false;
}

let pdfPromise = null;

function hasPdfLib(lib) {
  return !!(lib && lib.getDocument);
}

/** Best-effort lazy load of vendored pdf.js (assets/vendor/pdf.min.mjs). */
export function ensurePdf() {
  if (pdfPromise) return pdfPromise;
  pdfPromise = (async () => {
    try {
      const lib = await import(PDF_LIB_URL);
      try {
        const workerUrl = new URL(PDF_WORKER_URL, import.meta.url).toString();
        if (lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = workerUrl;
      } catch {
        // workerSrc is best-effort; pdf.js still parses (slower fake-worker path)
      }
      return hasPdfLib(lib) ? lib : null;
    } catch {
      return null;
    }
  })();
  return pdfPromise;
}

let tessPromise = null;

function hasTesseract() {
  try {
    return !!(window.Tesseract && window.Tesseract.recognize);
  } catch {
    return false;
  }
}

/** Best-effort lazy load of vendored tesseract.js (OCR for scanned PDFs). */
export function ensureTesseract() {
  if (hasTesseract()) return Promise.resolve(true);
  if (tessPromise) return tessPromise;
  tessPromise = new Promise((resolve) => {
    try {
      const s = document.createElement("script");
      s.src = TESS_SCRIPT_URL;
      s.async = true;
      s.onload = () => resolve(hasTesseract());
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
      setTimeout(() => resolve(hasTesseract()), 8000);
    } catch {
      resolve(false);
    }
  });
  return tessPromise;
}

/* ---------------- model helpers ---------------- */

export function run(text, b, i) {
  return { text: String(text || ""), b: !!b, i: !!i };
}

export function runsText(runs) {
  return (runs || []).map((r) => (r && r.text) || "").join("");
}

export function blockText(block) {
  if (!block) return "";
  if (block.t === "p" || block.t === "h") return runsText(block.runs);
  if (block.t === "ul" || block.t === "ol") return (block.items || []).map(runsText).join(" ");
  if (block.t === "table")
    return (block.rows || []).map((row) => (row || []).map(runsText).join(" | ")).join("\n");
  if (block.t === "img") return block.alt ? `[image: ${block.alt}]` : "[image]";
  return "";
}

/** Plain-text excerpt for the single-card preview (mirrors audio meta line). */
export function excerptOf(model, maxLen) {
  const n = Math.max(40, Number(maxLen) || 240);
  const parts = [];
  for (const b of (model && model.blocks) || []) {
    const t = blockText(b).trim();
    if (t) parts.push(t);
    if (parts.join(" ").length >= n) break;
  }
  const s = parts.join(" ").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function escXml(s) {
  return String(s || "").replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  })[c]);
}

function escHtml(s) {
  return escXml(s);
}

function b64encode(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

function b64decode(b64) {
  const s = atob(String(b64 || "").replace(/\s+/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  const cs = new CompressionStream("deflate-raw");
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(buf);
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

/* ---------------- hand-rolled ZIP ---------------- */
// Central-directory parse (immune to data descriptors); writer emits
// plain stored/deflated entries. No ZIP64, no encryption — those throw
// honest errors instead of corrupt output.

export function zipHasStreams() {
  return hasZip();
}

export async function zipRead(buffer) {
  if (!hasZip()) throw new Error("zip-unsupported");
  let raw;
  if (buffer instanceof Uint8Array) raw = buffer;
  else if (buffer instanceof ArrayBuffer) raw = new Uint8Array(buffer);
  else if (buffer && buffer.buffer instanceof ArrayBuffer)
    raw = new Uint8Array(buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
  else raw = new Uint8Array(buffer);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let eocd = -1;
  for (let i = raw.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip-corrupt");
  const count = view.getUint16(eocd + 10, true);
  const dec = new TextDecoder("utf-8");
  const out = new Map();
  let p = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("zip-corrupt");
    const flags = view.getUint16(p + 8, true);
    if (flags & 0x1) throw new Error("zip-encrypted");
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compLen = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const lhOff = view.getUint32(p + 42, true);
    if (view.getUint32(lhOff, true) !== 0x04034b50) throw new Error("zip-corrupt");
    const name = dec.decode(raw.subarray(p + 46, p + 46 + nameLen));
    const nameLenLH = view.getUint16(lhOff + 26, true);
    const extraLenLH = view.getUint16(lhOff + 28, true);
    const dataStart = lhOff + 30 + nameLenLH + extraLenLH;
    const comp = raw.subarray(dataStart, dataStart + compLen);
    let data;
    if (method === 0) data = comp.slice();
    else if (method === 8) {
      try {
        data = await inflateRaw(comp);
      } catch {
        throw new Error("zip-corrupt");
      }
    } else throw new Error("zip-unsupported-method");
    if (crc32(data) !== crc) throw new Error("zip-corrupt");
    if (!name.endsWith("/")) out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export async function zipWrite(entries) {
  if (!hasZip()) throw new Error("zip-unsupported");
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = enc.encode(e.name);
    const data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
    const comp = e.method === 0 ? data : await deflateRaw(data);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, e.method === 0 ? 0 : 8, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameB.length, true);
    chunks.push(new Uint8Array(lh.buffer), nameB, comp);
    central.push({ nameB, crc, compLen: comp.length, len: data.length, method: e.method === 0 ? 0 : 8, offset });
    offset += 30 + nameB.length + comp.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, c.method, true);
    ch.setUint32(16, c.crc, true);
    ch.setUint32(20, c.compLen, true);
    ch.setUint32(24, c.len, true);
    ch.setUint16(28, c.nameB.length, true);
    ch.setUint32(42, c.offset, true);
    chunks.push(new Uint8Array(ch.buffer), c.nameB);
    cdSize += 46 + c.nameB.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length, true);
  end.setUint16(10, central.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, cdStart, true);
  chunks.push(new Uint8Array(end.buffer));
  return new Blob(chunks, { type: "application/zip" });
}

/* ---------------- TXT ---------------- */

export function decodeTxt(text) {
  // Consecutive non-empty lines join into one paragraph (mirrors Markdown),
  // so TXT -> TXT is identity for typical files.
  const blocks = [];
  let cur = [];
  const flush = () => {
    if (cur.length) {
      blocks.push({ t: "p", runs: [run(cur.join(" "))] });
      cur = [];
    }
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (t) cur.push(t);
    else flush();
  }
  flush();
  if (!blocks.length) blocks.push({ t: "p", runs: [run("")] });
  return { blocks };
}

function encodeTxt(model) {
  const lines = [];
  for (const b of model.blocks) {
    if (b.t === "img") lines.push(b.alt ? `[image: ${b.alt}]` : "[image]", "");
    else if (b.t === "ul" || b.t === "ol") {
      (b.items || []).forEach((it, i) =>
        lines.push((b.t === "ol" ? `${i + 1}. ` : "- ") + runsText(it)));
      lines.push("");
    } else {
      const t = blockText(b);
      if (t) lines.push(t, "");
    }
  }
  return new Blob([lines.join("\n").replace(/\n+$/, "") + "\n"], { type: DOC_MIME_FOR.TXT });
}

/* ---------------- Markdown ---------------- */

function mdInline(text) {
  const runs = [];
  const re = /(\*\*.+?\*\*|\*[^*]+?\*|`[^`]+?|__[^_]+?__|_[^_]+?_)/g;
  let last = 0, m;
  const push = (t, b, i) => { if (t) runs.push(run(t, b, i)); };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**") || tok.startsWith("__")) push(tok.slice(2, -2), true, false);
    else if (tok.startsWith("`")) push(tok.slice(1, -1));
    else push(tok.slice(1, -1), false, true);
    last = m.index + tok.length;
  }
  push(text.slice(last));
  if (!runs.length) runs.push(run(text));
  return runs;
}

export function decodeMd(text) {
  const blocks = [];
  const lines = String(text || "").split(/\r?\n/);
  let para = [];
  let list = null; // { t, items }
  const flushPara = () => {
    if (para.length) {
      blocks.push({ t: "p", runs: mdInline(para.join(" ")) });
      para = [];
    }
  };
  const flushList = () => {
    if (list && list.items.length) blocks.push(list);
    list = null;
  };
  const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const h = /^(#{1,6})\s+(.*)/.exec(line);
    if (h) {
      flushPara(); flushList();
      blocks.push({ t: "h", level: Math.min(6, h[1].length), runs: mdInline(h[2]) });
      continue;
    }
    if (line.includes("|") && line.trim().startsWith("|")) {
      flushPara(); flushList();
      const rawCells = line.split("|").slice(1, -1).map((c) => c.trim());
      // Separator row (| --- | --- |): structural, not content — skip it.
      if (rawCells.length && rawCells.every((c) => /^:?-{1,}:?$/.test(c))) continue;
      const cells = rawCells.map((c) => mdInline(c));
      const lastB = blocks[blocks.length - 1];
      if (lastB && lastB.t === "table" && !lastB._closed) lastB.rows.push(cells.map((c) => c));
      else blocks.push({ t: "table", rows: [cells.map((c) => c)] });
      continue;
    }
    // close tables on non-row lines
    const lastT = blocks[blocks.length - 1];
    if (lastT && lastT.t === "table") lastT._closed = true;
    const ul = /^[-*+]\s+(.*)/.exec(line);
    const ol = /^(\d+)[.)]\s+(.*)/.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      const content = (ul ? ul[1] : ol[2]);
      const im = imgRe.exec(content);
      if (im) {
        flushList();
        const img = mdImage(im[2], im[1]);
        blocks.push(img ? img : { t: "p", runs: [run(`[image: ${im[1] || im[2]}]`, false, true)] });
        continue;
      }
      if (!list || list.t !== kind) { flushList(); list = { t: kind, items: [] }; }
      list.items.push(mdInline(content));
      continue;
    }
    flushList();
    const im = imgRe.exec(line);
    if (im && line.trim() === im[0]) {
      const img = mdImage(im[2], im[1]);
      blocks.push(img ? img : { t: "p", runs: [run(`[image: ${im[1] || im[2]}]`, false, true)] });
      continue;
    }
    para.push(line);
  }
  flushPara(); flushList();
  blocks.forEach((b) => { delete b._tbl; delete b._closed; });
  if (!blocks.length) blocks.push({ t: "p", runs: [run("")] });
  return { blocks };
}

function mdImage(src, alt) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(src || "").trim());
  if (!m) return null;
  try {
    return {
      t: "img",
      data: b64decode(m[3]),
      mime: m[1] || "image/png",
      name: "image",
      alt: alt || "",
    };
  } catch {
    return null;
  }
}

function mdRuns(runs) {
  return (runs || []).map((r) => {
    let t = String((r && r.text) || "").replace(/\|/g, "\\|");
    if (r && r.b && r.i) return `***${t}***`;
    if (r && r.b) return `**${t}**`;
    if (r && r.i) return `*${t}*`;
    return t;
  }).join("");
}

function encodeMd(model) {
  const out = [];
  for (const b of model.blocks) {
    if (b.t === "h") out.push(`${"#".repeat(Math.min(6, b.level || 1))} ${runsText(b.runs)}`, "");
    else if (b.t === "ul") { (b.items || []).forEach((it) => out.push(`- ${mdRuns(it)}`)); out.push(""); }
    else if (b.t === "ol") { (b.items || []).forEach((it, i) => out.push(`${i + 1}. ${mdRuns(it)}`)); out.push(""); }
    else if (b.t === "table") {
      const rows = b.rows || [];
      rows.forEach((row, ri) => {
        out.push(`| ${(row || []).map((c) => mdRuns(c)).join(" | ")} |`);
        if (ri === 0) out.push(`| ${(row || []).map(() => "---").join(" | ")} |`);
      });
      out.push("");
    } else if (b.t === "img") {
      const bytes = b.data instanceof Uint8Array ? b.data : new Uint8Array(b.data || []);
      const mime = b.mime || "image/png";
      const alt = b.alt || b.name || "image";
      // Self-contained data URI: the .md alone renders everywhere offline.
      out.push(`![${alt}](data:${mime};base64,${b64encode(bytes)})`, "");
    } else {
      out.push(mdRuns(b.runs), "");
    }
  }
  return new Blob([out.join("\n").replace(/\n+$/, "") + "\n"], { type: DOC_MIME_FOR.MD });
}

/* ---------------- RTF ---------------- */
// Subset parser: paragraphs, bold/italic, \par/\line/\tab, \'hh + \uN
// escapes, common punctuation controls, tables (\trowd..\cell..\row),
// and {\pict} images (\pngblip/\jpegblip hex dumps). Stylesheets,
// footnotes, and fields are skipped; their text still flows through.

const RTF_PUNCT = {
  emdash: "—", endash: "–", bullet: "•", lquote: "‘", rquote: "’",
  ldblquote: "“", rdblquote: "”", lquote2: "‚", rquote2: "‚",
};

export function decodeRtf(text) {
  const s = String(text || "");
  const blocks = [];
  let runs = [];
  let b = false, i = false;
  let cellRuns = null, row = null;
  const push = (t) => { if (t) runs.push(run(t, b, i)); };
  // Drain pending runs: merge adjacent same-style runs (the parser pushes
  // per char), trim boundary whitespace, keep bold/italic structure.
  const drainRuns = () => {
    const kept = [];
    for (const r of runs) {
      if (!r.text) continue;
      const prev = kept[kept.length - 1];
      if (prev && !!prev.b === !!r.b && !!prev.i === !!r.i) prev.text += r.text;
      else kept.push({ text: r.text, b: !!r.b, i: !!r.i });
    }
    runs = [];
    if (kept.length) {
      kept[0].text = kept[0].text.replace(/^\s+/, "");
      kept[kept.length - 1].text = kept[kept.length - 1].text.replace(/\s+$/, "");
    }
    return kept.filter((r) => r.text);
  };
  const endPara = () => {
    const content = drainRuns();
    if (cellRuns !== null) cellRuns.push(...(content.length ? content : [run("")]));
    else if (content.length) blocks.push({ t: "p", runs: content });
  };
  // Same trim but returns the runs instead of pushing a paragraph.
  const takeRuns = () => drainRuns();
  // Picture capture: only the longest uninterrupted hex run is kept, so
  // control-word letters (the "b" in \pngblip) can't pollute the dump.
  const isHex = (c) => /[0-9a-fA-F]/.test(c);
  let pictDepth = -1, pictRun = "", pictBest = "", pictType = "";
  const pictCrack = () => {
    if (pictRun.length > pictBest.length) pictBest = pictRun;
    pictRun = "";
  };
  const closePict = (depth) => {
    if (pictDepth < 0 || depth >= pictDepth) return;
    pictCrack();
    if (pictBest.length >= 64 && pictBest.length % 2 === 0) {
      try {
        const data = new Uint8Array(pictBest.length / 2);
        for (let k = 0; k < data.length; k++) data[k] = parseInt(pictBest.substr(k * 2, 2), 16);
        const mime = pictType === "jpeg" ? "image/jpeg" : "image/png";
        const r = takeRuns();
        if (r.length && cellRuns === null) blocks.push({ t: "p", runs: r });
        blocks.push({ t: "img", data, mime, name: "image", alt: "" });
      } catch {
        // corrupt dump — text around it is already captured
      }
    }
    pictDepth = -1; pictBest = ""; pictRun = ""; pictType = "";
  };
  let depth = 0, skipDepth = -1;
  let n = s.length, k = 0;
  while (k < n) {
    const ch = s[k];
    if (skipDepth >= 0) {
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth < skipDepth) skipDepth = -1; }
      k++;
      continue;
    }
    if (pictDepth >= 0 && isHex(ch)) { pictRun += ch; k++; continue; }
    if (ch === "{") { depth++; pictCrack(); k++; continue; }
    if (ch === "}") { depth--; closePict(depth); k++; continue; }
    if (ch === "\\") {
      pictCrack();
      const nx = s[k + 1];
      if (nx === "\\" || nx === "{" || nx === "}") { push(nx); k += 2; continue; }
      if (nx === "'") {
        const hh = s.substr(k + 2, 2);
        push(String.fromCharCode(parseInt(hh, 16) || 63));
        k += 4;
        continue;
      }
      if (nx === "\n" || nx === "\r") { k += 2; continue; }
      let j = k + 1, word = "";
      while (j < n && /[a-zA-Z]/.test(s[j])) { word += s[j]; j++; }
      let arg = "";
      if (s[j] === "-" || (s[j] >= "0" && s[j] <= "9")) {
        const js = j;
        if (s[j] === "-") j++;
        while (j < n && s[j] >= "0" && s[j] <= "9") j++;
        arg = s.slice(js, j);
      }
      if (s[j] === " ") j++;
      k = j;
      if (word === "par" || word === "line") endPara();
      else if (word === "tab") push("\t");
      else if (word === "b") b = arg !== "0";
      else if (word === "i") i = arg !== "0";
      else if (word === "ul" || word === "strike") { /* toggles we don't model */ }
      else if (word === "u") {
        const code = Number(arg);
        push(String.fromCharCode(code < 0 ? code + 65536 : code));
      } else if (word === "~") push(" ");
      else if (word === "-") push("­");
      else if (word === "_") push("‑");
      else if (RTF_PUNCT[word]) push(RTF_PUNCT[word]);
      else if (word === "cell") {
        const r = takeRuns();
        if (row) row.push(r.length ? r : [run("")]);
      } else if (word === "row") {
        if (row && row.length) {
          const rr = takeRuns();
          if (rr.length) row.push(rr);
          blocks.push({ t: "table", rows: [row] });
        }
        row = null; cellRuns = null;
      } else if (word === "trowd") { row = []; cellRuns = []; }
      else if (word === "pict") { pictDepth = depth; pictRun = ""; pictBest = ""; pictType = ""; }
      else if (word === "pngblip") pictType = "png";
      else if (word === "jpegblip") pictType = "jpeg";
      else if (word === "fonttbl" || word === "colortbl" || word === "stylesheet" ||
               word === "info" || word === "footnote" || word === "field" || word === "fldinst") {
        skipDepth = depth;
      }
      continue;
    }
    if (ch === "\n" || ch === "\r") { k++; continue; }
    push(ch);
    k++;
  }
  endPara();
  if (row && row.length) {
    const rr = takeRuns();
    if (rr.length) row.push(rr);
    blocks.push({ t: "table", rows: [row] });
  }
  // Merge adjacent single-row tables from consecutive \trowd..\row groups.
  const merged = [];
  for (const bl of blocks) {
    const prev = merged[merged.length - 1];
    if (bl.t === "table" && prev && prev.t === "table" &&
        prev.rows.length === 1 && bl.rows.length === 1 &&
        prev.rows[0].length === bl.rows[0].length) {
      prev.rows.push(bl.rows[0]);
    } else merged.push(bl);
  }
  if (!merged.length) merged.push({ t: "p", runs: [run("")] });
  return { blocks: merged };
}

function rtfEscape(text) {
  let out = "";
  for (const ch of String(text || "")) {
    const code = ch.codePointAt(0);
    if (code === 92 || code === 123 || code === 125) out += "\\" + ch;
    else if (code === 10) out += "\\line ";
    else if (code < 128) out += ch;
    else if (code <= 255) out += "\\'" + code.toString(16).padStart(2, "0");
    else if (code <= 65535) out += "\\u" + (code > 32767 ? code - 65536 : code) + "?";
    else out += "?";
  }
  return out;
}

function rtfRuns(runs) {
  let out = "", cb = false, ci = false;
  for (const r of runs || []) {
    const nb = !!(r && r.b), ni = !!(r && r.i);
    if (nb !== cb) { out += nb ? "\\b " : "\\b0 "; cb = nb; }
    if (ni !== ci) { out += ni ? "\\i " : "\\i0 "; ci = ni; }
    out += rtfEscape((r && r.text) || "");
  }
  if (cb) out += "\\b0 ";
  if (ci) out += "\\i0 ";
  return out;
}

function rtfPara(runs, size) {
  return `{\\pard\\fs${size || 22} ${rtfRuns(runs)}\\par}`;
}

function encodeRtf(model) {
  const parts = [
    "{\\rtf1\\ansi\\deff0",
    "{\\fonttbl{\\f0 Helvetica;}}",
    "{\\colortbl;}",
  ];
  for (const b of model.blocks) {
    if (b.t === "h") {
      const lv = Math.min(6, b.level || 1);
      parts.push(rtfPara(b.runs, lv === 1 ? 32 : lv === 2 ? 28 : 24).replace("{\\pard", "{\\pard\\b"));
    } else if (b.t === "ul") {
      for (const it of b.items || []) parts.push(`{\\pard\\fs22 \\'95\\tab ${rtfRuns(it)}\\par}`);
    } else if (b.t === "ol") {
      (b.items || []).forEach((it, idx) =>
        parts.push(`{\\pard\\fs22 ${idx + 1}.\\tab ${rtfRuns(it)}\\par}`));
    } else if (b.t === "table") {
      const rows = b.rows || [];
      const cols = Math.max(1, ...rows.map((r) => (r || []).length));
      const step = Math.max(600, Math.floor(9000 / cols));
      for (const row of rows) {
        let spec = "\\trowd";
        for (let c = 0; c < cols; c++) spec += `\\cellx${(c + 1) * step}`;
        parts.push(`{${spec}`);
        for (let c = 0; c < cols; c++) {
          const cell = (row || [])[c] || [run("")];
          parts.push(`{\\pard\\intbl\\fs20 ${rtfRuns(cell)}\\cell}`);
        }
        parts.push("\\row}");
      }
    } else if (b.t === "img") {
      const bytes = b.data instanceof Uint8Array ? b.data : new Uint8Array(b.data || []);
      const mime = b.mime || "image/png";
      const isJpeg = mime.includes("jpeg") || mime.includes("jpg");
      let hex = "";
      for (let q = 0; q < bytes.length; q++) hex += bytes[q].toString(16).padStart(2, "0");
      const dim = imageDims(bytes, mime) || { w: 400, h: 300 };
      const tw = Math.min(8000, Math.round((dim.w / (dim.h || 1)) * 3000));
      parts.push(`{\\pard {\\pict\\${isJpeg ? "jpeg" : "png"}blip\\picw${dim.w}\\pich${dim.h}\\picwgoal${tw}\\pichgoal3000\n${hex}\n}\\par}`);
    } else {
      parts.push(rtfPara(b.runs));
    }
  }
  parts.push("}");
  return new Blob([parts.join("\n")], { type: DOC_MIME_FOR.RTF });
}

/** Fast dimension sniff for JPEG (SOF) and PNG (IHDR); null otherwise. */
export function imageDims(bytes, mime) {
  try {
    if (!bytes || bytes.length < 30) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let p = 2;
      while (p + 9 < bytes.length) {
        if (bytes[p] !== 0xff) break;
        const m = bytes[p + 1];
        const len = (bytes[p + 2] << 8) | bytes[p + 3];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8) {
          return { w: (bytes[p + 7] << 8) | bytes[p + 8], h: (bytes[p + 5] << 8) | bytes[p + 6] };
        }
        p += 2 + len;
      }
      return null;
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      return {
        w: (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19],
        h: (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23],
      };
    }
  } catch {
    // sniff is best-effort
  }
  return null;
}

/* ---------------- PDF input (vendored pdf.js + OCR fallback) ---------------- */

async function pdfTextBlocks(pdf) {
  const blocks = [];
  {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      let items = [];
      try {
        const tc = await page.getTextContent();
        items = tc.items || [];
      } catch {
        items = [];
      }
      // Group glyph runs into visual lines (y-buckets), then sort by x.
      const lines = new Map();
      for (const it of items) {
        const str = String((it && it.str) || "");
        if (!str.trim()) continue;
        const tr = (it && it.transform) || [1, 0, 0, 1, 0, 0];
        const x = tr[4], y = Math.round(tr[5] / 4) * 4;
        if (!lines.has(y)) lines.set(y, []);
        lines.get(y).push({ x, str });
      }
      const ys = [...lines.keys()].sort((a, b2) => b2 - a);
      let paras = [], prevBottom = null;
      const flushP = () => {
        if (paras.length) {
          blocks.push({ t: "p", runs: [run(paras.join(" "))] });
          paras = [];
        }
      };
      for (const y of ys) {
        const line = lines.get(y).sort((a, c2) => a.x - c2.x).map((g) => g.str).join("");
        if (prevBottom !== null && prevBottom - y > 22) flushP();
        paras.push(line);
        prevBottom = y;
      }
      flushP();
      try { page.cleanup(); } catch { /* ignore */ }
    }
  }
  return blocks;
}

async function pdfOcrBlocks(pdf, onProgress) {
  const ok = await ensureTesseract();
  if (!ok) throw new Error("ocr-unsupported");
  const blocks = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(2400, Math.ceil(viewport.width));
    canvas.height = Math.min(3200, Math.ceil(viewport.height));
    const scale = Math.min(1, canvas.width / viewport.width);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("ocr-failed");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: ctx,
      viewport: scale === 1 ? viewport : page.getViewport({ scale: 2 * scale }),
    }).promise;
    try { page.cleanup(); } catch { /* ignore */ }
    let text = "";
    try {
      const base = tessVendorBase();
      const res = await window.Tesseract.recognize(canvas, "eng", {
        workerPath: `${base}/tesseract-worker.min.js?v=1`,
        langPath: base,
        corePath: base,
        gzip: true,
        logger: (m) => {
          try {
            if (onProgress && m && m.status === "recognizing text") onProgress(m.progress || 0);
          } catch { /* progress is best-effort */ }
        },
      });
      text = String((res && res.data && res.data.text) || "");
    } catch {
      throw new Error("ocr-failed");
    }
    for (const para of text.split(/\n\s*\n/)) {
      const t = para.replace(/\s+/g, " ").trim();
      if (t) blocks.push({ t: "p", runs: [run(t)] });
    }
  }
  return blocks;
}

async function decodePdf(blob, onProgress) {
  const lib = await ensurePdf();
  if (!lib) throw new Error("pdf-unsupported");
  let data;
  try {
    data = await blob.arrayBuffer();
  } catch {
    throw new Error("decode-failed");
  }
  const pdf = await lib.getDocument({ data }).promise;
  try {
    const textBlocks = await pdfTextBlocks(pdf);
    if (textBlocks.length) return { blocks: textBlocks };
    // No extractable text — scanned-image PDF. OCR it (user-approved path).
    try {
      if (onProgress) onProgress("ocr");
    } catch { /* ignore */ }
    const ocr = await pdfOcrBlocks(pdf, onProgress && onProgress.ocr);
    if (!ocr.length) throw new Error("pdf-no-text");
    return { blocks: ocr, ocr: true };
  } finally {
    try { await pdf.destroy(); } catch { /* ignore */ }
  }
}

/* ---------------- DOCX ---------------- */

function domParse(bytes, mime) {
  const text = new TextDecoder("utf-8").decode(bytes);
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("xml-corrupt");
  void mime;
  return doc;
}

function localName(el) {
  const n = (el && (el.localName || el.nodeName)) || "";
  const i = n.indexOf(":");
  return i >= 0 ? n.slice(i + 1) : n;
}

function childEls(el) {
  const out = [];
  for (let c = el && el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) out.push(c);
  }
  return out;
}

function findChild(el, name) {
  for (const c of childEls(el)) {
    if (localName(c) === name) return c;
  }
  return null;
}

function findAll(el, name, out) {
  out = out || [];
  for (const c of childEls(el)) {
    if (localName(c) === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

function docxRuns(pEl) {
  const runs = [];
  const walk = (el, b, i) => {
    for (const c of childEls(el)) {
      const ln = localName(c);
      if (ln === "r") {
        let rb = b, ri = i;
        const pr = findChild(c, "rPr");
        if (pr) {
          if (findChild(pr, "b")) rb = true;
          if (findChild(pr, "i")) ri = true;
        }
        for (const g of childEls(c)) {
          const gl = localName(g);
          if (gl === "t") runs.push(run(g.textContent || "", rb, ri));
          else if (gl === "tab") runs.push(run("\t"));
          else if (gl === "br" || gl === "cr") runs.push(run("\n"));
          else if (gl === "drawing" || gl === "pict") { /* images resolved at block level */ }
        }
      } else if (ln === "hyperlink" || ln === "smartTag" || ln === "sdtContent") {
        walk(c, b, i);
      }
    }
  };
  walk(pEl, false, false);
  return runs;
}

function docxParaStyle(pEl) {
  const pPr = findChild(pEl, "pPr");
  const ps = pPr && findChild(pPr, "pStyle");
  return (ps && (ps.getAttribute("w:val") || "")) || "";
}

function decodeDocx(bytes) {
  return (async () => {
    const zip = await zipRead(bytes);
    let docXml = null;
    for (const [name, data] of zip) {
      if (name === "word/document.xml") docXml = data;
    }
    if (!docXml) throw new Error("docx-corrupt");
    let doc;
    try {
      doc = domParse(docXml);
    } catch {
      throw new Error("docx-corrupt");
    }
    const rels = new Map();
    for (const [name, data] of zip) {
      if (name === "word/_rels/document.xml.rels") {
        try {
          const rd = domParse(data);
          for (const r of findAll(rd, "Relationship")) {
            const id = r.getAttribute("Id");
            let target = r.getAttribute("Target") || "";
            if (target && !/^(https?:|mailto:)/i.test(target)) {
              target = target.replace(/\\/g, "/");
              if (!target.startsWith("word/")) target = "word/" + target.replace(/^\//, "");
            }
            if (id && target) rels.set(id, target);
          }
        } catch {
          // rels are best-effort; text still converts
        }
      }
    }
    const images = new Map(); // target path -> { data, mime }
    for (const [name, data] of zip) {
      if (/^word\/media\//.test(name)) {
        const ext = (name.split(".").pop() || "").toLowerCase();
        const mime = ext === "png" ? "image/png"
          : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
          : ext === "gif" ? "image/gif" : "application/octet-stream";
        images.set(name, { data, mime, name: name.split("/").pop() });
      }
    }
    const body = findChild(doc.documentElement, "body");
    if (!body) throw new Error("docx-corrupt");
    const blocks = [];
    let list = null;
    const flushList = () => { if (list && list.items.length) blocks.push(list); list = null; };
    const pushBlock = (bl) => { flushList(); blocks.push(bl); };
    for (const el of childEls(body)) {
      const ln = localName(el);
      if (ln === "p") {
        const runs = docxRuns(el);
        // Embedded images live in drawings attached to runs.
        const imgs = [];
        for (const blip of findAll(el, "blip")) {
          const rid = blip.getAttribute("r:embed") || blip.getAttribute("embed");
          const target = rid && rels.get(rid);
          if (target && images.has(target)) imgs.push(images.get(target));
        }
        const style = docxParaStyle(el);
        const hm = /^Heading([1-6])$/i.exec(style) || /^heading ([1-6])$/i.exec(style);
        const numPr = findChild(findChild(el, "pPr") || el, "numPr");
        // python-docx / Word list styles carry no direct numPr (it lives on
        // the style); recognise their styleIds explicitly.
        const listStyle = /^List(Bullet\d*|Number\d*)$/.test(style)
          ? (style.startsWith("ListNumber") ? "ol" : "ul")
          : null;
        const listKind = numPr ? "ul" : listStyle;
        const text = runsText(runs).replace(/\n/g, " ").trim();
        if (hm) pushBlock({ t: "h", level: Number(hm[1]), runs: runs.length ? runs : [run(text)] });
        else if (listKind) {
          if (!list || list.t !== listKind) {
            flushList();
            list = { t: listKind, items: [] };
          }
          list.items.push(runs.length ? runs : [run(text)]);
        } else {
          if (text || imgs.length) {
            if (text) pushBlock({ t: "p", runs });
            for (const im of imgs) {
              pushBlock({ t: "img", data: im.data, mime: im.mime, name: im.name, alt: "" });
            }
          }
        }
      } else if (ln === "tbl") {
        flushList();
        const rows = [];
        for (const tr of childEls(el)) {
          if (localName(tr) !== "tr") continue;
          const cells = [];
          for (const tc of childEls(tr)) {
            if (localName(tc) !== "tc") continue;
            const cellRuns = [];
            for (const p of findAll(tc, "p")) {
              const pr = docxRuns(p);
              if (cellRuns.length) cellRuns.push(run(" "));
              cellRuns.push(...pr);
            }
            cells.push(cellRuns.length ? cellRuns : [run("")]);
          }
          if (cells.length) rows.push(cells);
        }
        if (rows.length) blocks.push({ t: "table", rows });
      } else if (ln === "sectPr") {
        // page setup — nothing to carry
      }
    }
    flushList();
    if (!blocks.length) throw new Error("docx-no-text");
    return { blocks };
  })();
}

function docxRunsXml(runs) {
  return (runs || []).map((r) => {
    const props = `${r && r.b ? "<w:b/>" : ""}${r && r.i ? "<w:i/>" : ""}`;
    const text = escXml((r && r.text) || "").replace(/\n/g, " ");
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  }).join("");
}

function encodeDocx(model) {
  return (async () => {
    const blocks = model.blocks || [];
    const media = []; // { name, data, mime, rid }
    let imgSeq = 0;
    const body = [];
    const numDefs = new Set();
    for (const b of blocks) {
      if (b.t === "h") {
        const lv = Math.min(3, Math.max(1, b.level || 1));
        body.push(`<w:p><w:pPr><w:pStyle w:val="Heading${lv}"/></w:pPr>${docxRunsXml(b.runs)}</w:p>`);
      } else if (b.t === "ul" || b.t === "ol") {
        const numId = b.t === "ol" ? 2 : 1;
        numDefs.add(b.t);
        for (const it of b.items || []) {
          body.push(`<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${docxRunsXml(it)}</w:p>`);
        }
      } else if (b.t === "table") {
        const rows = b.rows || [];
        const cols = Math.max(1, ...rows.map((r) => (r || []).length));
        const cellW = Math.max(800, Math.floor(9000 / cols));
        body.push(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${cellW}"/>`).join("")}</w:tblGrid>`);
        for (const row of rows) {
          body.push("<w:tr>");
          for (let c = 0; c < cols; c++) {
            const cell = (row || [])[c] || [run("")];
            body.push(`<w:tc><w:tcPr><w:tcW w:w="${cellW}" w:type="dxa"/></w:tcPr><w:p>${docxRunsXml(cell)}</w:p></w:tc>`);
          }
          body.push("</w:tr>");
        }
        body.push("</w:tbl>");
      } else if (b.t === "img") {
        const bytes = b.data instanceof Uint8Array ? b.data : new Uint8Array(b.data || []);
        const mime = b.mime || "image/png";
        const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
        const dim = imageDims(bytes, mime) || { w: 600, h: 450 };
        const scale = Math.min(1, 600 / dim.w);
        const dw = Math.round(dim.w * scale), dh = Math.round(dim.h * scale);
        imgSeq++;
        const rid = `rIdImg${imgSeq}`;
        const fname = `image${imgSeq}.${ext}`;
        media.push({ name: fname, data: bytes, mime, rid });
        const emus = (px) => Math.round(px * 9525);
        body.push(`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${emus(dw)}" cy="${emus(dh)}"/><wp:docPr id="${imgSeq}" name="${escXml(b.alt || fname)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${imgSeq}" name="${escXml(fname)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emus(dw)}" cy="${emus(dh)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
      } else {
        body.push(`<w:p>${docxRunsXml(b.runs)}</w:p>`);
      }
    }
    const contentTypes = [
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
      `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`,
      ...media.map((m) => `<Override PartName="/word/media/${m.name}" ContentType="${m.mime}"/>`),
    ].join("");
    const rels = media.map((m) =>
      `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join("");
    const numbering = `<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
    void numDefs;
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
    const enc = new TextEncoder();
    const entries = [
      { name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.open-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${contentTypes}</Types>`), method: 8 },
      { name: "_rels/.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`), method: 8 },
      { name: "word/document.xml", data: enc.encode(document), method: 8 },
      { name: "word/numbering.xml", data: enc.encode(numbering), method: 8 },
      { name: "word/_rels/document.xml.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${rels}</Relationships>`), method: 8 },
      ...media.map((m) => ({ name: `word/media/${m.name}`, data: m.data, method: 8 })),
    ];
    const zip = await zipWrite(entries);
    return new Blob([zip], { type: DOC_MIME_FOR.DOCX });
  })();
}

/* ---------------- EPUB ---------------- */

// Join a relative href onto a zip-internal DIRECTORY (opfDir, chapter dir).
// (Unlike URL resolution, the base here is a directory, not a file —
// popping its last segment broke every manifest lookup during testing.)
function epubJoin(dir, href) {
  const b = String(dir || "") ? String(dir).split("/") : [];
  for (const seg of String(href || "").split("/")) {
    if (seg === "." || seg === "") continue;
    else if (seg === "..") b.pop();
    else b.push(seg);
  }
  return b.join("/");
}

function epubBlocksFromDoc(doc, files, base, images) {
  const blocks = [];
  const body = doc.querySelector("body") || doc.documentElement;
  // Inline <img> resolves into stash so image blocks land AFTER the
  // paragraph that references them (never before it, never inside lists).
  const walk = (el, b, i, stash) => {
    const runs = [];
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const t = (c.textContent || "").replace(/\s+/g, " ");
        if (t.trim()) runs.push(run(t, b, i));
      } else if (c.nodeType === 1) {
        const tag = (c.localName || c.nodeName || "").toLowerCase();
        if (tag === "br") runs.push(run("\n"));
        else if (tag === "b" || tag === "strong") runs.push(...walk(c, true, i, stash));
        else if (tag === "i" || tag === "em" || tag === "cite") runs.push(...walk(c, b, true, stash));
        else if (tag === "img") {
          const src = c.getAttribute("src") || "";
          const alt = c.getAttribute("alt") || "";
          const img = epubResolveImage(src, alt, files, base, images);
          if (img === "pending" || !img) {
            if (alt || !img) runs.push(run(`[image: ${alt || src}]`, false, true));
          } else if (stash) stash.push(img);
          else runs.push(run(img.alt ? `[image: ${img.alt}]` : "[image]", false, true));
        } else runs.push(...walk(c, b, i, stash));
      }
    }
    return runs;
  };
  const pushRuns = (runs, stash) => {
    const t = runsText(runs).replace(/\n/g, " ").trim();
    if (t) blocks.push({ t: "p", runs });
    if (stash && stash.length) blocks.push(...stash.splice(0));
  };
  for (let el = body.firstChild; el; el = el.nextSibling) {
    if (el.nodeType === 3) {
      const t = (el.textContent || "").trim();
      if (t) blocks.push({ t: "p", runs: [run(t)] });
      continue;
    }
    if (el.nodeType !== 1) continue;
    const tag = (el.localName || el.nodeName || "").toLowerCase();
    const hm = /^h([1-6])$/.exec(tag);
    if (hm) {
      const stash = [];
      const runs = walk(el, true, false, stash);
      if (runsText(runs).trim()) blocks.push({ t: "h", level: Number(hm[1]), runs });
      if (stash.length) blocks.push(...stash);
    } else if (tag === "p" || tag === "div" || tag === "section" || tag === "blockquote") {
      // Nested lists/tables inside divs become their own blocks.
      const nested = [];
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1) {
          const ct = (c.localName || "").toLowerCase();
          if (ct === "ul" || ct === "ol" || ct === "table" || ct === "img") nested.push(c);
        }
      }
      const stash = [];
      if (nested.length) {
        const runs = walk(el, false, false, stash);
        if (runsText(runs).replace(/\n/g, " ").trim()) pushRuns(runs, stash);
        else if (stash.length) blocks.push(...stash.splice(0));
        for (const nx of nested) epubBlockElement(nx, blocks, files, base, images, walk);
      } else pushRuns(walk(el, false, false, stash), stash);
    } else if (tag === "ul" || tag === "ol" || tag === "table") {
      epubBlockElement(el, blocks, files, base, images, walk);
    } else if (tag === "img") {
      const src = el.getAttribute("src") || "";
      const img = epubResolveImage(src, el.getAttribute("alt") || "", files, base, images);
      if (img && img !== "pending") blocks.push(img);
    } else if (tag === "hr" || tag === "br") {
      // separators carry no text
    } else {
      const stash = [];
      const runs = walk(el, false, false, stash);
      if (runsText(runs).trim()) pushRuns(runs, stash);
      else if (stash.length) blocks.push(...stash.splice(0));
    }
  }
  return blocks;
}

function epubBlockElement(el, blocks, files, base, images, walk) {
  const tag = (el.localName || "").toLowerCase();
  if (tag === "ul" || tag === "ol") {
    const items = [];
    for (let li = el.firstChild; li; li = li.nextSibling) {
      if (li.nodeType === 1 && (li.localName || "").toLowerCase() === "li") {
        const r = walk(li, false, false);
        if (runsText(r).trim()) items.push(r);
      }
    }
    if (items.length) blocks.push({ t: tag, items });
  } else if (tag === "table") {
    const rows = [];
    const trs = el.querySelectorAll("tr");
    for (const tr of trs) {
      const cells = [];
      for (let c = tr.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1) {
          const ct = (c.localName || "").toLowerCase();
          if (ct === "td" || ct === "th") {
            const isH = ct === "th";
            const r = walk(c, isH, false);
            cells.push(r.length ? r : [run("")]);
          }
        }
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) blocks.push({ t: "table", rows });
  }
}

function epubResolveImage(src, alt, files, base, images) {
  if (!src || /^(https?:|data:)/i.test(src)) {
    if (/^data:/i.test(src || "")) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src.trim());
      if (m) {
        try {
          const img = { t: "img", data: b64decode(m[3]), mime: m[1] || "image/png", name: "image", alt };
          images.push(img);
          return img;
        } catch {
          return "pending";
        }
      }
    }
    return alt ? "pending" : null;
  }
  const key = epubJoin(base, src.split("#")[0]);
  const data = files.get(key);
  if (!data) return alt ? "pending" : null;
  const ext = (key.split(".").pop() || "").toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : "image/png";
  const img = { t: "img", data, mime, name: key.split("/").pop(), alt };
  images.push(img);
  return img;
}

function decodeEpub(bytes) {
  return (async () => {
    const zip = await zipRead(bytes);
    const container = zip.get("META-INF/container.xml");
    if (!container) throw new Error("epub-corrupt");
    let cdoc;
    try {
      cdoc = domParse(container);
    } catch {
      throw new Error("epub-corrupt");
    }
    const rootfile = cdoc.querySelector("rootfile");
    const opfPath = rootfile && rootfile.getAttribute("full-path");
    if (!opfPath) throw new Error("epub-corrupt");
    const opfBytes = zip.get(opfPath);
    if (!opfBytes) throw new Error("epub-corrupt");
    let opf;
    try {
      opf = domParse(opfBytes);
    } catch {
      throw new Error("epub-corrupt");
    }
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
    const manifest = new Map(); // href -> { id, mime }
    for (const item of opf.querySelectorAll("item")) {
      const href = item.getAttribute("href");
      if (href) manifest.set(epubJoin(opfDir, href.split("#")[0]), {
        id: item.getAttribute("id"),
        mime: item.getAttribute("media-type") || "",
      });
    }
    const spine = [];
    for (const ref of opf.querySelectorAll("itemref")) {
      const idref = ref.getAttribute("idref");
      for (const [href, m] of manifest) {
        if (m.id === idref && /x?html/.test(m.mime)) spine.push(href);
      }
    }
    const blocks = [];
    const seenImages = [];
    for (const href of spine) {
      const data = zip.get(href);
      if (!data) continue;
      const text = new TextDecoder("utf-8").decode(data);
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");
      const base = href.includes("/") ? href.slice(0, href.lastIndexOf("/")) : "";
      blocks.push(...epubBlocksFromDoc(doc, zip, base, seenImages));
    }
    if (!blocks.length) throw new Error("epub-no-text");
    return { blocks };
  })();
}

function epubHtmlRuns(runs) {
  return (runs || []).map((r) => {
    const t = escHtml((r && r.text) || "");
    if (r && r.b && r.i) return `<strong><em>${t}</em></strong>`;
    if (r && r.b) return `<strong>${t}</strong>`;
    if (r && r.i) return `<em>${t}</em>`;
    return t;
  }).join("");
}

function encodeEpub(model) {
  return (async () => {
    const blocks = model.blocks || [];
    const images = []; // { href, data, mime }
    const paras = [];
    let imgSeq = 0;
    for (const b of blocks) {
      if (b.t === "h") {
        const lv = Math.min(3, Math.max(1, b.level || 1));
        paras.push(`<h${lv}>${epubHtmlRuns(b.runs)}</h${lv}>`);
      } else if (b.t === "ul" || b.t === "ol") {
        paras.push(`<${b.t}>${(b.items || []).map((it) => `<li>${epubHtmlRuns(it)}</li>`).join("")}</${b.t}>`);
      } else if (b.t === "table") {
        const rows = (b.rows || []).map((row) =>
          `<tr>${(row || []).map((c) => `<td>${epubHtmlRuns(c)}</td>`).join("")}</tr>`).join("");
        paras.push(`<table>${rows}</table>`);
      } else if (b.t === "img") {
        const bytes = b.data instanceof Uint8Array ? b.data : new Uint8Array(b.data || []);
        const mime = b.mime || "image/png";
        const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("gif") ? "gif" : "png";
        imgSeq++;
        const href = `images/img${imgSeq}.${ext}`;
        images.push({ href, data: bytes, mime });
        paras.push(`<p><img src="${href}" alt="${escHtml(b.alt || "")}"/></p>`);
      } else {
        paras.push(`<p>${epubHtmlRuns(b.runs)}</p>`);
      }
    }
    const chapter = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Converted</title><style>p{margin:0 0 0.8em}table{border-collapse:collapse;margin:0 0 0.8em}td{border:1px solid #666;padding:4px 8px}img{max-width:100%}</style></head><body>${paras.join("\n")}</body></html>`;
    const manifestItems = [`<item id="chap1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>`,
      `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
      ...images.map((im, k) => `<item id="img${k + 1}" href="${im.href}" media-type="${im.mime}"/>`)].join("");
    const opf = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Converted document</dc:title><dc:language>en</dc:language><dc:identifier id="id">chameleon-doc</dc:identifier></metadata><manifest>${manifestItems}</manifest><spine toc="ncx"><itemref idref="chap1"/></spine></package>`;
    const ncx = `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="chameleon-doc"/></head><docTitle><text>Converted document</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>Start</text></navLabel><content src="chapter1.xhtml"/></navPoint></navMap></ncx>`;
    const enc = new TextEncoder();
    const entries = [
      { name: "mimetype", data: enc.encode("application/epub+zip"), method: 0 },
      { name: "META-INF/container.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`), method: 8 },
      { name: "OEBPS/content.opf", data: enc.encode(opf), method: 8 },
      { name: "OEBPS/toc.ncx", data: enc.encode(ncx), method: 8 },
      { name: "OEBPS/chapter1.xhtml", data: enc.encode(chapter), method: 8 },
      ...images.map((im) => ({ name: `OEBPS/${im.href}`, data: im.data, method: 8 })),
    ];
    const zip = await zipWrite(entries);
    return new Blob([zip], { type: DOC_MIME_FOR.EPUB });
  })();
}

/* ---------------- PDF output (hand-rolled writer) ---------------- */
// A4, built-in Helvetica family, text + ruled tables + JPEG/PNG images.
// Mirrors encodeAudio's WAV role: zero-dependency output. Quality maps to
// embedded-image fidelity (max width + JPEG q); pure text ignores it.

const HELV_WIDTHS = {
  32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191,
  40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
  48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
  56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556,
  64: 1015, 65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778,
  80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
  88: 667, 89: 667, 90: 611, 91: 278, 92: 278, 93: 278, 94: 469, 95: 556,
  96: 233, 97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278, 103: 556,
  104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833, 110: 556,
  111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278, 117: 556,
  118: 500, 119: 722, 120: 500, 121: 500, 122: 500, 123: 334, 124: 260,
  125: 334, 126: 584,
  161: 278, 162: 556, 163: 556, 164: 556, 165: 556, 166: 260, 167: 556,
  168: 333, 169: 737, 170: 400, 171: 556, 172: 584, 173: 333, 174: 737,
  175: 333, 176: 400, 177: 584, 178: 400, 179: 400, 180: 333, 181: 556,
  182: 556, 183: 278, 184: 333, 185: 400, 186: 400, 187: 556, 188: 834,
  189: 834, 190: 834, 191: 556, 192: 667, 193: 667, 194: 667, 195: 667,
  196: 667, 197: 667, 198: 1000, 199: 722, 200: 667, 201: 667, 202: 667,
  203: 667, 204: 278, 205: 278, 206: 278, 207: 278, 208: 722, 209: 722,
  210: 778, 211: 778, 212: 778, 213: 778, 214: 778, 215: 584, 216: 778,
  217: 722, 218: 722, 219: 722, 220: 722, 221: 667, 222: 667, 223: 611,
  224: 556, 225: 556, 226: 556, 227: 556, 228: 556, 229: 556, 230: 611,
  231: 500, 232: 556, 233: 556, 234: 556, 235: 556, 236: 222, 237: 222,
  238: 222, 239: 222, 240: 556, 241: 556, 242: 556, 243: 556, 244: 556,
  245: 556, 246: 556, 247: 584, 248: 556, 249: 556, 250: 556, 251: 556,
  252: 556, 253: 500, 254: 556, 255: 500,
};

// Unicode -> WinAnsi byte (latin-1 identity + mapped punctuation).
const WINANSI_EXTRA = {
  8364: 128, 8218: 130, 402: 131, 8222: 132, 8230: 133, 8224: 134, 8225: 135,
  710: 136, 8240: 137, 352: 138, 8249: 139, 338: 140, 381: 142, 8216: 145,
  8217: 146, 8220: 147, 8221: 148, 8226: 149, 8211: 150, 8212: 151, 732: 152,
  8482: 153, 353: 154, 8250: 155, 339: 156, 382: 158, 376: 159,
};
HELV_WIDTHS[128] = 556; HELV_WIDTHS[130] = 333; HELV_WIDTHS[131] = 333;
HELV_WIDTHS[132] = 556; HELV_WIDTHS[133] = 1000; HELV_WIDTHS[134] = 278;
HELV_WIDTHS[135] = 556; HELV_WIDTHS[136] = 333; HELV_WIDTHS[137] = 1000;
HELV_WIDTHS[138] = 667; HELV_WIDTHS[139] = 556; HELV_WIDTHS[140] = 1000;
HELV_WIDTHS[142] = 667; HELV_WIDTHS[145] = 191; HELV_WIDTHS[146] = 191;
HELV_WIDTHS[147] = 556; HELV_WIDTHS[148] = 556; HELV_WIDTHS[149] = 350;
HELV_WIDTHS[150] = 556; HELV_WIDTHS[151] = 1000; HELV_WIDTHS[152] = 333;
HELV_WIDTHS[153] = 1000; HELV_WIDTHS[154] = 500; HELV_WIDTHS[155] = 556;
HELV_WIDTHS[156] = 611; HELV_WIDTHS[158] = 500; HELV_WIDTHS[159] = 667;

function pdfByte(ch) {
  const code = ch.codePointAt(0);
  if (code < 128) return code;
  if (code <= 255) return code;
  return WINANSI_EXTRA[code] || 63; // "?" fallback
}

function pdfTextWidth(text, size) {
  let w = 0;
  for (const ch of String(text || "")) w += HELV_WIDTHS[pdfByte(ch)] || 556;
  return (w * size) / 1000;
}

function pdfEscape(text) {
  let out = "";
  for (const ch of String(text || "")) {
    const b = pdfByte(ch);
    if (b === 40 || b === 41 || b === 92) out += "\\" + String.fromCharCode(b);
    else out += String.fromCharCode(b);
  }
  return out;
}

function pdfWrapPara(text, size, maxW) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (pdfTextWidth(t, size) <= maxW || !cur) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

async function pdfImageXObject(img, quality) {
  const bytes = img.data instanceof Uint8Array ? img.data : new Uint8Array(img.data || []);
  const mime = img.mime || "";
  const dim = imageDims(bytes, mime);
  const q = Math.min(100, Math.max(1, Number(quality) || 82));
  const maxW = 400 + (q / 100) * 1200;
  const jpegQ = 0.4 + (0.6 * q) / 100;
  // JPEG passthrough: zero re-encode cost, full fidelity.
  if ((mime.includes("jpeg") || mime.includes("jpg")) && dim && dim.w <= maxW) {
    return { kind: "jpg", data: bytes, w: dim.w, h: dim.h };
  }
  // Otherwise rasterize through canvas (PNG/JPEG/GIF/BMP -> JPEG).
  try {
    const blob = new Blob([bytes], { type: mime || "image/png" });
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxW / (bmp.width || maxW));
    const w = Math.max(1, Math.round((bmp.width || 1) * scale));
    const h = Math.max(1, Math.round((bmp.height || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) { if (bmp.close) bmp.close(); return null; }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const out = await new Promise((resolve) => {
      if (!canvas.toBlob) { resolve(null); return; }
      canvas.toBlob((b2) => resolve(b2), "image/jpeg", jpegQ);
    });
    if (!out) return null;
    const buf = new Uint8Array(await out.arrayBuffer());
    return { kind: "jpg", data: buf, w, h };
  } catch {
    return null;
  }
}

function encodePdf(model, quality) {
  return (async () => {
    const W = 595, H = 842, M = 72;
    const maxW = W - M * 2;
    const pages = []; // { ops: [], images: [{ ref, xo }] }
    let ops = [], xobjs = [];
    let y = H - M;
    const newPage = () => {
      if (ops.length || xobjs.length) pages.push({ ops, xobjs });
      ops = []; xobjs = [];
      y = H - M;
    };
    const need = (h) => { if (y - h < M) newPage(); };
    const textLine = (x, yy, font, size, text) => {
      ops.push(`BT /${font} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${pdfEscape(text)}) Tj ET`);
    };
    const paraRuns = (runs, size, indent) => {
      // Wrap on the joined text, then attribute each line back to runs by
      // character offset (wrap collapses whitespace, so offsets are exact).
      const fontOf = (r) => (r.b && r.i ? "F4" : r.b ? "F2" : r.i ? "F3" : "F1");
      const list = runs && runs.length ? runs : [run("")];
      // Normalize run-by-run, merging boundary spaces, so bounds index the
      // exact string the wrapper sees (no drift at run edges).
      let norm = "";
      const bounds = [];
      for (const r of list) {
        let t = String((r && r.text) || "").replace(/\s+/g, " ");
        if (!t) continue;
        if (t.startsWith(" ") && (!norm || norm.endsWith(" "))) t = t.slice(1);
        if (!t) continue;
        bounds.push({ start: norm.length, end: norm.length + t.length, f: fontOf(r || {}) });
        norm += t;
      }
      if (norm.endsWith(" ")) norm = norm.slice(0, -1);
      const lines = pdfWrapPara(norm, size, maxW - indent);
      let global = 0;
      const fontAt = (pos) => {
        for (const bd of bounds) if (pos < bd.end) return bd.f;
        return bounds.length ? bounds[bounds.length - 1].f : "F1";
      };
      for (const line of lines) {
        need(size * 1.35);
        let xx = M + indent;
        let segStart = 0, segFont = fontAt(global);
        const emit = (a, b2, f) => {
          if (b2 <= a) return;
          textLine(xx, y, f, size, line.slice(a, b2));
          xx += pdfTextWidth(line.slice(a, b2), size);
        };
        for (let ci = 0; ci < line.length; ci++) {
          const f = fontAt(global + ci);
          if (f !== segFont) { emit(segStart, ci, segFont); segStart = ci; segFont = f; }
        }
        emit(segStart, line.length, segFont);
        y -= size * 1.35;
        global += line.length + 1;
      }
    };
    const gap = (h) => { y -= h; };
    let imgCount = 0;
    for (const b of model.blocks || []) {
      if (b.t === "h") {
        const lv = Math.min(6, b.level || 1);
        const size = lv === 1 ? 17 : lv === 2 ? 14 : 12;
        need(size * 1.6 + 6);
        gap(6);
        paraRuns((b.runs || []).map((r) => ({ text: r.text, b: true, i: r.i })), size, 0);
        gap(4);
      } else if (b.t === "ul" || b.t === "ol") {
        (b.items || []).forEach((it, idx) => {
          const marker = b.t === "ol" ? `${idx + 1}. ` : "• ";
          paraRuns([{ text: marker, b: false, i: false }, ...(it || [])], 11, 18);
          gap(2);
        });
        gap(4);
      } else if (b.t === "table") {
        const rows = b.rows || [];
        const cols = Math.max(1, ...rows.map((r) => (r || []).length));
        const cw = maxW / cols;
        for (const row of rows) {
          const wrapped = [];
          let rh = 0;
          for (let c = 0; c < cols; c++) {
            const wl = pdfWrapPara(runsText((row || [])[c] || []), 10.5, cw - 8);
            wrapped.push(wl);
            rh = Math.max(rh, wl.length);
          }
          const rowH = Math.max(1, rh) * 10.5 * 1.3 + 6;
          need(rowH);
          const top = y;
          for (let c = 0; c < cols; c++) {
            const x0 = M + c * cw;
            ops.push(`${x0.toFixed(1)} ${(top - rowH).toFixed(1)} ${cw.toFixed(1)} ${rowH.toFixed(1)} re S`);
            (wrapped[c] || [""]).forEach((ln, li) => {
              textLine(x0 + 4, top - 11 - li * 10.5 * 1.3, "F1", 10.5, ln);
            });
          }
          y = top - rowH - 2;
        }
        gap(6);
      } else if (b.t === "img") {
        const xo = await pdfImageXObject(b, quality);
        if (!xo) {
          need(14);
          textLine(M, y, "F3", 11, b.alt ? `[image: ${b.alt}]` : "[image]");
          y -= 15;
          continue;
        }
        const scale = Math.min(1, maxW / xo.w);
        const dw = xo.w * scale, dh = xo.h * scale;
        need(dh + 4);
        imgCount++;
        const ref = `Im${imgCount}`;
        xobjs.push({ ref, xo });
        ops.push(`q ${dw.toFixed(1)} 0 0 ${dh.toFixed(1)} ${M.toFixed(1)} ${(y - dh).toFixed(1)} cm /${ref} Do Q`);
        y -= dh + 8;
      } else {
        const t = runsText(b.runs);
        if (!t.trim()) { gap(6); continue; }
        paraRuns(b.runs || [run("")], 11, 0);
        gap(5);
      }
    }
    if (ops.length || xobjs.length) pages.push({ ops, xobjs });
    if (!pages.length) pages.push({ ops: [], xobjs: [] });

    // Serialize: catalog(1) pages(2) fonts(3-6) then per-page content+xobjects.
    const enc = new TextEncoder();
    const objs = [];
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    const pageRefs = [];
    let nextId = 7;
    const pageObjs = [];
    for (const pg of pages) {
      const content = pg.ops.join("\n");
      const cb = enc.encode(content);
      const cId = nextId++;
      const dict = [`<< /Length ${cb.length} >>`, "stream", content, "endstream"].join("\n");
      const xoIds = [];
      for (const { ref, xo } of pg.xobjs) {
        const xId = nextId++;
        const jb = xo.data;
        let raw = "";
        for (let q = 0; q < jb.length; q++) raw += String.fromCharCode(jb[q]);
        xoIds.push(`/${ref} ${xId} 0 R`);
        objs[xId] = [`<< /Type /XObject /Subtype /Image /Width ${xo.w} /Height ${xo.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jb.length} >>`, "stream", raw, "endstream"].join("\n");
      }
      const pId = nextId++;
      pageRefs.push(`${pId} 0 R`);
      pageObjs.push({ pId, cId, xoIds });
      objs[cId] = dict;
    }
    objs[2] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pages.length} >>`;
    objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
    objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>";
    objs[6] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique >>";
    for (const pg of pageObjs) {
      objs[pg.pId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >>${pg.xoIds.length ? ` /XObject << ${pg.xoIds.join(" ")} >>` : ""} >> /Contents ${pg.cId} 0 R >>`;
    }
    let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets = {};
    const maxId = nextId - 1;
    for (let id = 1; id <= maxId; id++) {
      if (!objs[id]) continue;
      offsets[id] = pdf.length;
      pdf += `${id} 0 obj\n${objs[id]}\nendobj\n`;
    }
    const xrefAt = pdf.length;
    pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= maxId; id++) {
      pdf += `${String(offsets[id] || 0).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
    // Blob must stay byte-exact: latin-1 encode (all chars < 256 by construction).
    const out = new Uint8Array(pdf.length);
    for (let k = 0; k < pdf.length; k++) out[k] = pdf.charCodeAt(k) & 0xff;
    return new Blob([out], { type: DOC_MIME_FOR.PDF });
  })();
}

/* ---------------- public dispatch ---------------- */

function docExtOf(name) {
  const n = String(name || "").toLowerCase();
  const i = n.lastIndexOf(".");
  return i >= 0 ? n.slice(i) : "";
}

/**
 * Decode any supported document Blob to the shared model.
 * Resolves { model, excerpt, ocr? }. Throws honest error codes:
 * decode-failed, pdf-unsupported, pdf-no-text, ocr-unsupported,
 * ocr-failed, zip-unsupported, zip-encrypted, zip-corrupt,
 * docx-corrupt, docx-no-text, epub-corrupt, epub-no-text, rtf-corrupt.
 */
export async function decodeDoc(blob, nameHint, onProgress) {
  const name = (blob && blob.name) || nameHint || "";
  const ext = docExtOf(name);
  if (ext === ".txt") {
    const model = decodeTxt(await blob.text());
    return { model, excerpt: excerptOf(model) };
  }
  if (ext === ".md" || ext === ".markdown") {
    const model = decodeMd(await blob.text());
    return { model, excerpt: excerptOf(model) };
  }
  if (ext === ".rtf") {
    let model;
    try {
      model = decodeRtf(await blob.text());
    } catch {
      throw new Error("rtf-corrupt");
    }
    return { model, excerpt: excerptOf(model) };
  }
  if (ext === ".pdf") return decodePdf(blob, onProgress).then((r) => ({
    model: { blocks: r.blocks },
    excerpt: excerptOf({ blocks: r.blocks }),
    ocr: !!r.ocr,
  }));
  if (ext === ".docx") {
    if (!hasZip()) throw new Error("zip-unsupported");
    let bytes;
    try {
      bytes = new Uint8Array(await blob.arrayBuffer());
    } catch {
      throw new Error("decode-failed");
    }
    const r = await decodeDocx(bytes);
    return { model: { blocks: r.blocks }, excerpt: excerptOf({ blocks: r.blocks }) };
  }
  if (ext === ".epub") {
    if (!hasZip()) throw new Error("zip-unsupported");
    let bytes;
    try {
      bytes = new Uint8Array(await blob.arrayBuffer());
    } catch {
      throw new Error("decode-failed");
    }
    const r = await decodeEpub(bytes);
    return { model: { blocks: r.blocks }, excerpt: excerptOf({ blocks: r.blocks }) };
  }
  throw new Error("decode-failed");
}

/**
 * Encode the shared model to target ("TXT"|"MD"|"RTF"|"PDF"|"DOCX"|"EPUB").
 */
export async function encodeDoc(model, target, quality) {
  const t = String(target || "").toUpperCase();
  if (!model || !Array.isArray(model.blocks) || !model.blocks.length) {
    throw new Error("decode-failed");
  }
  if (t === "TXT") return encodeTxt(model);
  if (t === "MD") return encodeMd(model);
  if (t === "RTF") return encodeRtf(model);
  if (t === "PDF") return encodePdf(model, quality);
  if (t === "DOCX") return encodeDocx(model);
  if (t === "EPUB") return encodeEpub(model);
  throw new Error("unsupported-target");
}

export function extForDoc(target) {
  const t = String(target || "").toLowerCase();
  if (t === "docx") return "docx";
  if (t === "epub") return "epub";
  if (t === "pdf") return "pdf";
  if (t === "rtf") return "rtf";
  if (t === "md") return "md";
  return "txt";
}

/** "notes.txt" + "PDF" -> "notes.pdf". */
export function outNameDoc(srcName, target) {
  const base = String(srcName || "converted").replace(/\.[a-z0-9]+$/i, "") || "converted";
  return `${base}.${extForDoc(target)}`;
}
