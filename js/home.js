/* Chameleon — home page wiring (v1: collect + hand off).
   Validates image files, maintains a multi-file queue, lets the user pick
   PNG/JPG/WEBP, then stages blobs in IndexedDB and navigates to
   convert.html?staged=1&target=<fmt>. The target row shows "Works with"
   family tags until files arrive, then swaps to format chips; reaching 2+
   files stages and navigates automatically. Everything stays local. */

import { initScramble } from "./scramble.js";
import { isSupported, stubKind, fmtSize, IMAGE_TARGETS } from "./convert.js";
import { pushHistory } from "./history.js";
import { putStaged } from "./store.js";

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 20;

const drop = document.getElementById("drop");
const fileInput = document.getElementById("file-input");
const browseBtn = document.getElementById("browse-btn");
const queueEl = document.getElementById("queue");
const fileInfo = document.getElementById("file-info");
const statusEl = document.getElementById("status");
const convertBtn = document.getElementById("convert-btn");
const chipsEl = document.getElementById("target-chips");

const FAMILIES = ["images", "audio", "video"];

function cap1(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const queue = []; // { hid, file, url? }
let target = "png";
let seq = 0;
let busy = false;

function setStatus(msg) {
  statusEl.textContent = msg;
}

function renderTargets() {
  chipsEl.innerHTML = "";
  const label = document.createElement("span");
  label.className = "cap";
  label.style.marginRight = "6px";
  if (queue.length === 0) {
    label.textContent = "Works with";
    chipsEl.setAttribute("aria-label", "Works with");
    chipsEl.append(label);
    for (const f of FAMILIES) {
      const b = document.createElement("button");
      b.className = "chip";
      b.type = "button";
      b.dataset.family = f;
      b.textContent = cap1(f);
      chipsEl.append(b);
    }
    return;
  }
  label.textContent = "Convert to";
  chipsEl.setAttribute("aria-label", "Convert to");
  chipsEl.append(label);
  for (const f of IMAGE_TARGETS) {
    const on = f === target;
    const b = document.createElement("button");
    b.className = "chip" + (on ? " on" : "");
    b.type = "button";
    b.dataset.f = f;
    b.textContent = f.toUpperCase();
    b.setAttribute("aria-pressed", String(on));
    chipsEl.append(b);
  }
  const more = document.createElement("a");
  more.className = "chip";
  more.href = "convert.html";
  more.innerHTML = "More &rarr;";
  chipsEl.append(more);
}

function syncTargets() {
  renderTargets();
  renderQueue();
}

function thumbUrl(file) {
  const t = String(file.type || "").toLowerCase();
  const n = String(file.name || "").toLowerCase();
  const isImg =
    t.startsWith("image/") ||
    [".png", ".jpg", ".jpeg", ".svg", ".webp", ".heic", ".heif"].some((e) => n.endsWith(e));
  if (!isImg) return null;
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

function describeRejection(file) {
  if (file.size > MAX_BYTES) return `${file.name}: over 50 MB — pick a smaller file.`;
  const kind = stubKind(file);
  if (kind === "audio" || kind === "video" || kind === "document")
    return `${file.name}: ${kind} conversion is coming soon — images only for now.`;
  if (kind === "image")
    return `${file.name}: that image type isn't supported yet — PNG / JPG / SVG / WEBP / HEIC only.`;
  return `${file.name}: unsupported file — PNG / JPG / SVG / WEBP / HEIC only.`;
}

function addFiles(files) {
  const incoming = [...files];
  if (!incoming.length) return;
  const rejected = [];
  let added = 0;

  for (const file of incoming) {
    if (queue.length >= MAX_FILES) {
      rejected.push(`${file.name}: queue is full (max ${MAX_FILES}).`);
      continue;
    }
    if (!isSupported(file) || file.size > MAX_BYTES) {
      rejected.push(describeRejection(file));
      continue;
    }
    const hid = "h" + Date.now().toString(36) + "-" + seq++;
    const url = thumbUrl(file);
    queue.push({ hid, file, url });
    pushHistory({ id: hid, name: file.name, size: file.size, format: target });
    added++;
  }

  syncTargets();
  if (added > 0 && queue.length >= 2) {
    stageAndGo();
    return;
  }
  if (added && !rejected.length) setStatus(added === 1 ? "File added — pick a format, then Convert." : `${added} files added — pick a format, then Convert.`);
  else if (added && rejected.length) setStatus(`${added} added. ${rejected[0]}`);
  else if (rejected.length) setStatus(rejected[0]);
}

function removeAt(i) {
  const [rm] = queue.splice(i, 1);
  if (rm && rm.url) {
    try {
      URL.revokeObjectURL(rm.url);
    } catch {
      // ignore
    }
  }
  syncTargets();
  setStatus(queue.length ? `${queue.length} file${queue.length === 1 ? "" : "s"} selected.` : "No files selected yet.");
}

function renderQueue() {
  queueEl.innerHTML = "";
  queue.forEach(({ file }, i) => {
    const li = document.createElement("li");
    li.className = "file-card";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const entry = queue[i];
    if (entry.url) {
      const img = document.createElement("img");
      img.src = entry.url;
      img.alt = "";
      img.loading = "lazy";
      img.onerror = () => {
        thumb.classList.remove("has-img");
        thumb.textContent = "IMG";
      };
      thumb.appendChild(img);
      thumb.classList.add("has-img");
    } else {
      thumb.textContent = "IMG";
      thumb.setAttribute("aria-hidden", "true");
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("b");
    name.textContent = file.name;
    name.title = file.name;
    const sub = document.createElement("span");
    sub.textContent = `${fmtSize(file.size)} → ${target.toUpperCase()}`;
    meta.append(name, sub);

    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.type = "button";
    remove.textContent = "✕";
    remove.setAttribute("aria-label", "Remove " + file.name);
    remove.addEventListener("click", () => removeAt(i));

    li.append(thumb, meta, remove);
    queueEl.appendChild(li);
  });

  queueEl.hidden = queue.length === 0;
  convertBtn.disabled = queue.length === 0 || busy;
  convertBtn.textContent = queue.length ? `Convert ${queue.length} file${queue.length === 1 ? "" : "s"} →` : "Convert →";
  fileInfo.textContent = queue.length === 0 ? "No files selected yet." : `${queue.length} file${queue.length === 1 ? "" : "s"} selected.`;
}

function openPicker() {
  fileInput.click();
}

function setDragging(on) {
  document.body.classList.toggle("dragging", on);
  drop.classList.toggle("dragover", on);
}

// --- events ---
browseBtn.addEventListener("click", openPicker);
drop.addEventListener("click", (e) => {
  if (e.target.closest("button,input")) return;
  openPicker();
});
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    openPicker();
  }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files.length) addFiles(fileInput.files);
  fileInput.value = "";
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files")) {
    dragDepth++;
    setDragging(true);
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (dragDepth > 0) dragDepth--;
  if (dragDepth <= 0 || !e.relatedTarget) {
    dragDepth = 0;
    setDragging(false);
  }
});
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragDepth = 0;
  setDragging(false);
  if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
});
window.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files);
});

chipsEl.addEventListener("click", (e) => {
  const fam = e.target.closest("[data-family]");
  if (fam) {
    if (fam.dataset.family === "images") openPicker();
    else setStatus(`${cap1(fam.dataset.family)} conversion is coming soon — images only for now.`);
    return;
  }
  const btn = e.target.closest(".chip[data-f]");
  if (!btn) return;
  target = btn.dataset.f;
  syncTargets();
  if (queue.length) setStatus(`${queue.length} file${queue.length === 1 ? "" : "s"} → ${target.toUpperCase()}.`);
});

async function stageAndGo() {
  if (!queue.length || busy) return;
  busy = true;
  renderQueue();
  setStatus("Staging files…");
  try {
    const entries = queue.map((q) => ({ file: q.file, name: q.file.name, size: q.file.size, type: q.file.type }));
    const { memoryOnly } = await putStaged(entries, target);
    if (memoryOnly) setStatus("Staged (this browser blocks storage — don't reload before converting).");
    location.href = `convert.html?staged=1&target=${encodeURIComponent(target)}`;
  } catch {
    setStatus("Couldn't stage files — try fewer or smaller files.");
    busy = false;
    renderQueue();
  }
}

convertBtn.addEventListener("click", stageAndGo);

// --- init ---
initScramble();
syncTargets();
setStatus("No files selected yet.");

// Scroll-driven accent theme: hero=orange, formats=teal, how=purple, CTA=lime.
// Middle-band observer so exactly one zone owns the theme at a time; when
// nested zones overlap (#how contains #faq) the deepest / latest wins.
const pg = document.querySelector(".pg");
const zones = [...document.querySelectorAll("[data-theme-zone]")];
const visible = new Set();
function applyTheme() {
  if (!pg || !zones.length) return;
  // Latest in document order among visible wins (handles #how > #faq nesting).
  let active = null;
  for (const z of zones) if (visible.has(z)) active = z;
  // Nothing in the middle band (fast scroll gaps): keep last theme.
  if (!active) return;
  const next = active.getAttribute("data-theme-zone");
  if (next && pg.dataset.theme !== next) pg.dataset.theme = next;
}
if (pg && zones.length && "IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
      applyTheme();
    },
    { rootMargin: "-45% 0px -45% 0px", threshold: 0 }
  );
  zones.forEach((z) => io.observe(z));
}

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
