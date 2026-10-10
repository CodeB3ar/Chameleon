/* Chameleon — file support checks + shared formatting (home v1).
   Images convert locally via canvas. Audio converts locally via Web Audio
   decode + WAV PCM / MediaRecorder / vendored MP3 encode. Documents convert
   locally via js/encode-doc.js (text transforms + hand-rolled PDF writer +
   vendored PDF text extraction). Video stubs only. */

export const IMAGE_TARGETS = ["png", "jpg", "svg", "webp"];
export const AUDIO_TARGETS = ["mp3", "wav", "ogg", "aac", "m4a"];
export const DOC_TARGETS = ["txt", "md", "rtf", "pdf", "docx", "epub"];

const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
  "image/heic",
  "image/heif",
];
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".svg", ".webp", ".heic", ".heif"];
const AUDIO_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/x-mp3",
  "audio/x-mpeg",
  "audio/mpeg3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/aac",
  "audio/aacp",
  "audio/ogg",
  "audio/opus",
  "audio/x-opus",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
  "audio/3gpp",
  "audio/3gpp2",
];
const AUDIO_EXTS = [".mp3", ".wav", ".aac", ".ogg", ".oga", ".opus", ".m4a", ".weba", ".3gp"];
const DOC_TYPES = [
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/rtf",
  "text/rtf",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/epub+zip",
];
const DOC_EXTS = [".txt", ".md", ".markdown", ".rtf", ".pdf", ".docx", ".epub"];

// Extensions we can explicitly name as "coming soon" instead of "unsupported".
// NOTE: GIF is intentionally not listed anywhere — it is unsupported.
const STUB_EXTS = [
  ".mp4", ".mov", ".webm", ".mkv", ".avi",
  ".bmp", ".tiff", ".tif",
];

export function extOf(name) {
  const n = String(name || "").toLowerCase();
  const i = n.lastIndexOf(".");
  return i >= 0 ? n.slice(i) : "";
}

export function isSupported(file) {
  if (!file) return false;
  const t = String(file.type || "").toLowerCase();
  if (IMAGE_TYPES.includes(t)) return true;
  if (AUDIO_TYPES.includes(t)) return true;
  if (DOC_TYPES.includes(t)) return true;
  const name = String(file.name || "").toLowerCase();
  return (
    IMAGE_EXTS.some((ext) => name.endsWith(ext)) ||
    AUDIO_EXTS.some((ext) => name.endsWith(ext)) ||
    DOC_EXTS.some((ext) => name.endsWith(ext))
  );
}

/** "stub" = recognisable format family we don't convert yet; "" = unknown. */
export function stubKind(file) {
  const ext = extOf(file && file.name);
  if (!ext) return "";
  if (!STUB_EXTS.includes(ext)) return "";
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(ext)) return "video";
  return "image";
}

/** Family of a file for grouping: "image" | "audio" | "video" | "document" | "". */
export function familyOf(file) {
  if (!file) return "";
  // GIF and AVIF are unsupported — never recognise them, even via generic image/* sniffing.
  const ext = extOf(file.name);
  const t = String(file.type || "").toLowerCase();
  if (ext === ".gif" || t === "image/gif") return "";
  if (ext === ".avif" || t === "image/avif") return "";
  if (IMAGE_TYPES.includes(t) || IMAGE_EXTS.some((e) => String(file.name || "").toLowerCase().endsWith(e)))
    return "image";
  if (AUDIO_TYPES.includes(t) || AUDIO_EXTS.some((e) => String(file.name || "").toLowerCase().endsWith(e)))
    return "audio";
  if (DOC_TYPES.includes(t) || DOC_EXTS.some((e) => String(file.name || "").toLowerCase().endsWith(e)))
    return "document";
  if (isSupported(file)) return "image";
  const kind = stubKind(file);
  if (kind) return kind;
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("video/")) return "video";
  return "";
}

/** True for files we recognise (convertible or listable stub). */
export function isKnown(file) {
  return familyOf(file) !== "";
}

// Targets actually encodable today (canvas pipeline + SVG wrapper).
// HEIC is input-only: no browser encodes it via canvas.
export const CONVERTIBLE_TARGETS = ["PNG", "JPG", "SVG", "WEBP"];
// Audio targets encodable via encode-audio.js (WAV always; the rest gated
// per-browser by supportsAudioTarget(), mirroring supportsWebp()).
export const AUDIO_CONVERTIBLE_TARGETS = ["MP3", "WAV", "OGG", "AAC", "M4A"];
// Document targets encodable via encode-doc.js (TXT/MD/RTF/PDF always;
// DOCX/EPUB need ZIP capability; PDF *input* needs vendored pdf.js).
// Gating lives in supportsDocTarget(), mirroring supportsAudioTarget().
export const DOC_CONVERTIBLE_TARGETS = ["TXT", "MD", "RTF", "PDF", "DOCX", "EPUB"];

/**
 * Per-family target options for custom mode.
 * [{ v: "WEBP", soon: false }] — soon options render disabled with
 * `label` as the visible reason (e.g. "soon", "input only").
 */
export function targetsFor(family) {
  if (family === "audio")
    return ["MP3", "WAV", "OGG", "AAC", "M4A"].map((v) => ({ v, soon: false }));
  if (family === "video") return ["MP4", "MOV", "WEBM"].map((v) => ({ v, soon: true, label: "soon" }));
  if (family === "document")
    return ["TXT", "MD", "RTF", "PDF", "DOCX", "EPUB"].map((v) => ({ v, soon: false }));
  return [
    { v: "PNG", soon: false },
    { v: "JPG", soon: false },
    { v: "SVG", soon: false },
    { v: "WEBP", soon: false },
    { v: "HEIC", soon: true, label: "input only" },
  ];
}

/** Sensible default target for a freshly added file. */
export function defaultTargetFor(family, globalTarget) {
  if (family === "image") {
    return CONVERTIBLE_TARGETS.includes(globalTarget) ? globalTarget : "WEBP";
  }
  if (family === "audio") {
    return AUDIO_CONVERTIBLE_TARGETS.includes(globalTarget) ? globalTarget : "MP3";
  }
  if (family === "video") return "MP4";
  if (family === "document") return "PDF";
  return globalTarget;
}

export function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
