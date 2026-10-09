/* Chameleon — local image decode/encode helpers (no deps).
   Decode via createImageBitmap (fallback: <img> + object URL).
   Encode via canvas.toBlob. SVG output wraps a PNG raster in
   <svg><image>. HEIC is input-only (no canvas encoder exists).
   Everything stays on-device. */

export const MIME_FOR = {
  PNG: "image/png",
  JPG: "image/jpeg",
  WEBP: "image/webp",
};

let webpCache = null;

/** Runtime check: can this browser encode WebP? (very old Safari cannot). */
export function supportsWebp() {
  if (webpCache !== null) return webpCache;
  try {
    const c = document.createElement("canvas");
    webpCache = c.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    webpCache = false;
  }
  return webpCache;
}

function isHeicBlob(blob, nameHint) {
  const t = String((blob && blob.type) || "").toLowerCase();
  if (t.includes("heic") || t.includes("heif")) return true;
  const n = String(nameHint || (blob && blob.name) || "").toLowerCase();
  return n.endsWith(".heic") || n.endsWith(".heif");
}

/** Decode a Blob/File to an ImageBitmap (or HTMLImageElement fallback). */
export async function decodeImage(blob, nameHint) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(blob);
    } catch {
      // fall through to <img> path (e.g. SVG / HEIC / corrupt header)
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => {
        if (isHeicBlob(blob, nameHint)) reject(new Error("heic-unsupported"));
        else reject(new Error("decode-failed"));
      };
      el.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function frameSize(src) {
  const w = src.width || src.naturalWidth;
  const h = src.height || src.naturalHeight;
  if (!w || !h) throw new Error("decode-failed");
  return { w, h };
}

/**
 * Read pixel dimensions without encoding. Resolves { w, h } or
 * null when the image can't be decoded here (e.g. HEIC on Chrome).
 */
export async function getImageDimensions(blob, nameHint) {
  try {
    const decoded = await decodeImage(blob, nameHint);
    try {
      return frameSize(decoded);
    } finally {
      if (decoded && decoded.close) {
        try {
          decoded.close();
        } catch {
          // ignore
        }
      }
    }
  } catch {
    return null;
  }
}

function canvasToBlob(canvas, mime, q) {
  return new Promise((resolve, reject) => {
    if (!canvas.toBlob) {
      reject(new Error("no-toblob"));
      return;
    }
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("encode-failed"));
      },
      mime,
      q
    );
  });
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("encode-failed"));
    r.readAsDataURL(blob);
  });
}

function drawToCanvas(decoded, target) {
  const { w, h } = frameSize(decoded);
  // Cap absurd dimensions (malicious SVG viewBox) to avoid OOM.
  const MAX_EDGE = 4096;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no-2d-context");
  // JPG has no alpha channel — flatten onto white so transparency
  // becomes white instead of black.
  if (target === "JPG") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
  }
  ctx.drawImage(decoded, 0, 0, cw, ch);
  return { canvas, w: cw, h: ch };
}

function escXml(s) {
  return String(s || "").replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  })[c]);
}

/**
 * Encode a decoded image to target ("PNG" | "JPG" | "SVG" | "WEBP").
 */
export async function encodeImage(decoded, target, quality) {
  if (target === "HEIC") return Promise.reject(new Error("heic-output-unsupported"));
  if (target === "GIF" || target === "AVIF") return Promise.reject(new Error("unsupported-target"));
  if (target === "WEBP" && !supportsWebp()) return Promise.reject(new Error("webp-unsupported"));

  // SVG output: raster wrapped in <svg><image> (no true vectorization locally).
  if (target === "SVG") {
    const { canvas, w, h } = drawToCanvas(decoded, "PNG");
    const png = await canvasToBlob(canvas, MIME_FOR.PNG);
    const dataUrl = await blobToDataURL(png);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<image width="${w}" height="${h}" href="${escXml(dataUrl)}"/>` +
      `</svg>`;
    return new Blob([svg], { type: "image/svg+xml" });
  }

  const mime = MIME_FOR[target];
  if (!mime) return Promise.reject(new Error("unsupported-target"));

  const { canvas } = drawToCanvas(decoded, target);
  const q = target === "PNG" ? undefined : Math.min(1, Math.max(0.01, quality / 100));
  return canvasToBlob(canvas, mime, q);
}

export function extFor(target) {
  return target === "JPG" ? "jpg" : target.toLowerCase();
}

/** "photo.png" + "webp" -> "photo.webp". */
export function outName(srcName, target) {
  const base = String(srcName || "converted").replace(/\.[a-z0-9]+$/i, "") || "converted";
  return `${base}.${extFor(target)}`;
}
