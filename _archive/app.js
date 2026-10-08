/* Chameleon — shell wiring. Queue files, pick a format, show status.
   No conversion logic (see js/convert.js stub). Everything stays local. */

import { initScramble } from "./scramble.js";
import { isSupported } from "./convert.js";
import { loadHistory, pushHistory, clearHistory, formatTime } from "./history.js";

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const queueEl = document.getElementById("queue");
const fileInfo = document.getElementById("file-info");
const statusEl = document.getElementById("status");
const browseBtn = document.getElementById("browse-btn");
const convertBtn = document.getElementById("convert-btn");
const historyBtn = document.getElementById("history-btn");
const historyPanel = document.getElementById("history-panel");
const historyList = document.getElementById("history-list");
const historyBadge = document.getElementById("history-badge");
const historyClear = document.getElementById("history-clear");

const queue = []; // { hid, file }
const live = new Map(); // hid -> File (only while queued)
const thumbUrls = new Map(); // hid -> objectURL (revoked on remove)
let target = "png";
let seq = 0;

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function svgIcon(name, cls = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", ("ic " + cls).trim());
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "assets/icons.svg#" + name);
  svg.appendChild(use);
  return svg;
}

function rememberThumb(hid, file) {
  if (!file.type || !file.type.startsWith("image/")) return;
  try {
    if (!thumbUrls.has(hid)) thumbUrls.set(hid, URL.createObjectURL(file));
  } catch {
    // object URLs unavailable — fallback icon stays
  }
}

function forgetThumb(hid) {
  const url = thumbUrls.get(hid);
  if (url) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    thumbUrls.delete(hid);
  }
}

function renderQueue() {
  queueEl.innerHTML = "";
  queue.forEach(({ hid, file }, i) => {
    const li = document.createElement("li");
    li.className = "file-card";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const url = thumbUrls.get(hid);
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      thumb.appendChild(img);
      thumb.classList.add("has-img");
    } else {
      thumb.appendChild(svgIcon("i-image"));
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("b");
    name.textContent = file.name;
    name.title = file.name;
    const sub = document.createElement("span");
    sub.textContent = fmtSize(file.size) + " → " + target.toUpperCase();
    meta.append(name, sub);

    const remove = document.createElement("button");
    remove.className = "remove-btn";
    remove.type = "button";
    remove.appendChild(svgIcon("i-close"));
    remove.setAttribute("aria-label", "Remove " + file.name);
    remove.addEventListener("click", () => {
      queue.splice(i, 1);
      live.delete(hid);
      forgetThumb(hid);
      renderQueue();
      renderHistory();
    });

    li.append(thumb, meta, remove);
    queueEl.appendChild(li);
  });

  convertBtn.disabled = queue.length === 0;
  fileInfo.textContent = queue.length === 0 ? "No files selected yet." : queue.length + " file(s) selected.";
  if (queue.length > 0) statusEl.textContent = "Shell preview — conversion is not wired yet.";
}

function renderHistory() {
  const entries = loadHistory();
  historyList.innerHTML = "";
  historyBadge.hidden = entries.length === 0;
  historyBadge.textContent = String(entries.length);

  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "history-empty";
    li.textContent = "Nothing yet — files you add will appear here.";
    historyList.appendChild(li);
    return;
  }

  for (const e of entries) {
    const li = document.createElement("li");
    const name = document.createElement("p");
    name.className = "h-name";
    name.textContent = e.name;
    const sub = document.createElement("p");
    sub.className = "h-sub";
    sub.textContent = fmtSize(e.size) + " → " + String(e.format || "").toUpperCase() + " · " + formatTime(e.ts);
    li.append(name, sub);

    const tag = document.createElement("span");
    if (live.has(e.id)) {
      tag.className = "h-link";
      tag.append(svgIcon("i-check", "ic-sm"), document.createTextNode(" in queue"));
    } else {
      tag.className = "h-expired";
      tag.textContent = "session expired — re-add the file to retry";
    }
    li.appendChild(tag);
    historyList.appendChild(li);
  }
}

function setHistory(open) {
  historyPanel.hidden = !open;
  historyBtn.setAttribute("aria-expanded", String(open));
}

historyBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setHistory(historyPanel.hidden);
});
document.addEventListener("click", (e) => {
  if (!historyPanel.hidden && !e.target.closest(".history-wrap")) setHistory(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !historyPanel.hidden) {
    setHistory(false);
    historyBtn.focus();
  }
});
historyClear.addEventListener("click", () => {
  clearHistory();
  renderHistory();
});

function addFiles(files) {
  let n = 0;
  for (const file of files) {
    if (!isSupported(file)) continue;
    const hid = "h" + Date.now().toString(36) + "-" + seq++;
    queue.push({ hid, file });
    live.set(hid, file);
    rememberThumb(hid, file);
    pushHistory({ id: hid, name: file.name, size: file.size, format: target });
    n++;
  }
  renderQueue();
  renderHistory();
  if (n === 0 && files.length > 0) statusEl.textContent = "Only PNG / JPG / WebP for now — shell preview.";
}

function openPicker() {
  fileInput.click();
}

function setDragging(on) {
  document.body.classList.toggle("dragging", on);
  dropZone.classList.toggle("dragover", on);
}

dropZone.addEventListener("click", (e) => {
  if (e.target.closest("input")) return;
  openPicker();
});
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    openPicker();
  }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files.length) addFiles(fileInput.files);
  fileInput.value = "";
});
browseBtn.addEventListener("click", openPicker);

// Drag counter — prevents flicker when crossing child nodes.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
    dragDepth++;
    setDragging(true);
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (dragDepth > 0) dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    setDragging(false);
  }
  if (!e.relatedTarget) {
    dragDepth = 0;
    setDragging(false);
  }
});
dropZone.addEventListener("drop", (e) => {
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

document.querySelectorAll(".chip:not(:disabled)").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
    target = btn.textContent.trim().toLowerCase();
    renderQueue();
  });
});

convertBtn.addEventListener("click", () => {
  statusEl.textContent = "Shell preview — conversion is not wired yet.";
});

initScramble();
renderQueue();
renderHistory();
