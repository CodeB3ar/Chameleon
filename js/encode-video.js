/* Chameleon — local video decode/encode helpers (no build step).
   Decode via a muted <video> element (all five inputs).
   Encode:
     MP4 / WEBM: native <video> -> <canvas> -> captureStream() +
           MediaRecorder pipeline (same role as the audio recorder
           pipeline), gated by supportsVideoTarget().
     MOV / MKV / AVI: no browser ships a MediaRecorder encoder for these
           containers, so they need a real muxer. That lives behind the
           OPTIONAL vendored ffmpeg build (assets/vendor/ffmpeg/, dropped
           in by the user on demand — never preloaded, never CDN). Until
           the vendor files are present, supportsVideoTarget() is false
           for those three and conversion throws an honest *-unsupported
           code instead of a dead click.
   Quality semantics: the 1-100 slider maps to resolution-cap RUNGS
     (never upscale):
       <=20 → 480p · <=40 → 720p · <=60 → 1080p · <=80 → 1440p (2K) ·
       >80  → 2160p (4K or source, whichever is smaller).
     Each rung also sets a videoBitsPerSecond hint for the recorder.
     Every video target respects quality (there is no lossless video
     target here, unlike PNG/WAV).
   Capability gating mirrors encode-audio.js supportsAudioTarget():
   unsupported targets render disabled with NO SUPPORT.
   Everything stays on-device. */

export const VIDEO_MIME_FOR = {
  MP4: "video/mp4",
  WEBM: "video/webm",
  MOV: "video/quicktime",
  MKV: "video/x-matroska",
  AVI: "video/x-msvideo",
};

// Candidate MediaRecorder mime strings per NATIVE target (first wins).
// MOV / MKV / AVI are intentionally absent: MediaRecorder.isTypeSupported
// never returns true for them in any shipping browser.
const RECORDER_MIMES = {
  MP4: ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"],
  WEBM: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
};

// Targets that need the optional ffmpeg vendor build (no native encoder).
export const FFMPEG_TARGETS = ["MOV", "MKV", "AVI"];
// Targets encodable natively today via the MediaRecorder pipeline.
export const NATIVE_VIDEO_TARGETS = ["MP4", "WEBM"];

// Slider (1-100) → resolution-cap rung. Order matters: first match wins.
const RUNGS = [
  { max: 20, capH: 480, label: "480p", bps: 1_000_000 },
  { max: 40, capH: 720, label: "720p", bps: 2_500_000 },
  { max: 60, capH: 1080, label: "1080p", bps: 5_000_000 },
  { max: 80, capH: 1440, label: "2K", bps: 10_000_000 },
  { max: 100, capH: 2160, label: "4K", bps: 16_000_000 },
];

/** Map 1-100 slider to a resolution rung { capH, label, bps }. */
export function qualityToRung(quality) {
  const q = Math.min(100, Math.max(1, Number(quality) || 82));
  for (const r of RUNGS) {
    if (q <= r.max) return { capH: r.capH, label: r.label, bps: r.bps };
  }
  return { capH: 2160, label: "4K", bps: 16_000_000 };
}

export function videoQualityLabel(quality) {
  return qualityToRung(quality).label;
}

const mimeCache = new Map();

function recorderMimeFor(target) {
  const t = String(target || "").toUpperCase();
  if (mimeCache.has(t)) return mimeCache.get(t);
  let found = null;
  const cands = RECORDER_MIMES[t] || [];
  try {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
      for (const m of cands) {
        try {
          if (MediaRecorder.isTypeSupported(m)) {
            found = m;
            break;
          }
        } catch {
          // try next
        }
      }
    }
  } catch {
    found = null;
  }
  mimeCache.set(t, found);
  return found;
}

function hasFfmpeg() {
  try {
    return !!(window.FFmpeg && (window.FFmpeg.createFFmpeg || window.FFmpeg.FFmpeg));
  } catch {
    return false;
  }
}

/** Runtime check: can this browser encode this video target right now? */
export function supportsVideoTarget(target) {
  const t = String(target || "").toUpperCase();
  if (NATIVE_VIDEO_TARGETS.includes(t)) return recorderMimeFor(t) !== null;
  if (FFMPEG_TARGETS.includes(t)) return hasFfmpeg();
  return false;
}

// NOTE: there is deliberately NO input (decode) probe here. canPlayType()
// is conservative and can report "" for containers the browser will still
// play from a real file (byte-sniffing at load), so a probe can wrongly
// claim NO SUPPORT where decoding actually works. Instead, every container
// is accepted as input and decodeVideo() attempts the read, surfacing an
// honest code (video-unsupported / decode-failed) only if that file truly
// won't decode here — the same INPUT ONLY pattern as HEIC. Dropping the
// optional ffmpeg build under assets/vendor/ffmpeg/ additionally unlocks
// MOV/MKV/AVI *output* (and decoding for exotic codecs inside them).

let ffmpegPromise = null;

/**
 * Best-effort lazy load of the OPTIONAL vendored ffmpeg build
 * (assets/vendor/ffmpeg/ffmpeg.min.js, user-supplied on demand).
 * Resolves true when the muxer is ready, false otherwise. Never
 * preloaded at page init — the multi-MB bytes only load when the user
 * explicitly picks MOV / MKV / AVI output (Tesseract precedent).
 */
export function ensureFfmpeg(onProgress) {
  if (hasFfmpeg()) return Promise.resolve(true);
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    try {
      const s = document.createElement("script");
      s.src = "./assets/vendor/ffmpeg/ffmpeg.min.js?v=1";
      s.async = true;
      s.onload = () => {
        try {
          if (onProgress) onProgress(1);
        } catch {
          // progress is best-effort
        }
        finish(hasFfmpeg());
      };
      s.onerror = () => finish(false);
      document.head.appendChild(s);
      // Don't hang conversion on vendor load.
      setTimeout(() => finish(hasFfmpeg()), 8000);
    } catch {
      finish(false);
    }
  });
  // A failed load must be retryable (user may drop the vendor in later).
  ffmpegPromise.then((ok) => {
    if (!ok) ffmpegPromise = null;
  });
  return ffmpegPromise;
}

/**
 * Decode a Blob/File to a ready <video> element handle.
 * Resolves { el, url, width, height, duration }. The caller owns
 * cleanup via closeVideo(). Throws video-unsupported / decode-failed.
 */
export async function decodeVideo(blob) {
  let url = null;
  try {
    url = URL.createObjectURL(blob);
  } catch {
    throw new Error("decode-failed");
  }
  const el = document.createElement("video");
  el.muted = true;
  el.playsInline = true;
  el.preload = "auto";
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("decode-failed")), 12000);
      el.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      el.onerror = () => {
        clearTimeout(timer);
        reject(new Error("decode-failed"));
      };
      el.src = url;
    });
  } catch (err) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
    if (err && err.message === "decode-failed") throw err;
    throw new Error("decode-failed");
  }
  const w = el.videoWidth || 0;
  const h = el.videoHeight || 0;
  if (!w || !h) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
    throw new Error("video-unsupported");
  }
  return { el, url, width: w, height: h, duration: el.duration };
}

/** Release a handle from decodeVideo(). */
export function closeVideo(decoded) {
  if (!decoded) return;
  try {
    if (decoded.el) {
      try {
        decoded.el.pause();
      } catch {
        // ignore
      }
      decoded.el.removeAttribute("src");
      decoded.el.load();
    }
  } catch {
    // ignore
  }
  try {
    if (decoded.url) URL.revokeObjectURL(decoded.url);
  } catch {
    // ignore
  }
}

/**
 * Lightweight metadata probe without a full re-encode (for list UI).
 * Resolves { w, h, duration } or null when unreadable here.
 */
export function getVideoMetadata(blob) {
  return new Promise((resolve) => {
    let url = null;
    try {
      url = URL.createObjectURL(blob);
    } catch {
      resolve(null);
      return;
    }
    try {
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      el.preload = "metadata";
      const done = (v) => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
        resolve(v);
      };
      const timer = setTimeout(() => done(null), 8000);
      el.onloadedmetadata = () => {
        clearTimeout(timer);
        const w = el.videoWidth || 0;
        const h = el.videoHeight || 0;
        const d = Number(el.duration);
        if (!w || !h) {
          done(null);
          return;
        }
        done({ w, h, duration: Number.isFinite(d) && d > 0 ? d : null });
      };
      el.onerror = () => {
        clearTimeout(timer);
        done(null);
      };
      el.src = url;
    } catch {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
      resolve(null);
    }
  });
}

export function fmtVideoDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s || s < 0) return "";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Rung-capped output dims for a source size (never upscale, even values). */
function rungDims(srcW, srcH, capH) {
  const w = Number(srcW) || 0;
  const h = Number(srcH) || 0;
  if (!w || !h) throw new Error("decode-failed");
  const scale = Math.min(1, capH / h);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { w: even(w * scale), h: even(h * scale) };
}

/**
 * Native re-encode: <video> -> rung-capped <canvas> -> captureStream()
 * (+ source audio mixed via MediaStreamDestination) -> MediaRecorder.
 */
async function encodeViaRecorder(decoded, mime, rung, onProgress) {
  const { el, width, height } = decoded;
  if (typeof MediaRecorder === "undefined") throw new Error("encode-unsupported");
  const { w, h } = rungDims(width, height, rung.capH);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no-2d-context");
  // Frame pump: draw each rAF while the video plays (canvas stream
  // only carries frames we paint).
  let pumpOn = true;
  const pump = () => {
    if (!pumpOn) return;
    try {
      ctx.drawImage(el, 0, 0, w, h);
    } catch {
      // decode hiccup mid-stream — keep the previous frame
    }
    requestAnimationFrame(pump);
  };
  const stream = canvas.captureStream(30);
  // Carry the source audio track when the browser allows it.
  let audioCtx = null;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx && el.captureStream) {
      const srcStream = el.captureStream();
      const audioTracks = srcStream.getAudioTracks();
      if (audioTracks.length) {
        audioCtx = new Ctx();
        const src = audioCtx.createMediaStreamSource(srcStream);
        const dest = audioCtx.createMediaStreamDestination();
        src.connect(dest);
        for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
      }
    } else if (Ctx && el.mozCaptureStream) {
      const srcStream = el.mozCaptureStream();
      const audioTracks = srcStream.getAudioTracks();
      if (audioTracks.length) {
        audioCtx = new Ctx();
        const src = audioCtx.createMediaStreamSource(srcStream);
        const dest = audioCtx.createMediaStreamDestination();
        src.connect(dest);
        for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
      }
    }
  } catch {
    // silent output is still a valid conversion
  }
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: rung.bps });
  } catch {
    pumpOn = false;
    try {
      if (audioCtx) await audioCtx.close();
    } catch {
      // ignore
    }
    throw new Error("encode-unsupported");
  }
  const chunks = [];
  const stopped = new Promise((resolve, reject) => {
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.onerror = () => reject(new Error("encode-failed"));
    rec.onstop = () => resolve();
  });
  const dur = Number(decoded.duration) || 0;
  const timeoutMs = Math.max(8000, (dur || 1) * 1000 * 2 + 5000);
  let watchdog = null;
  const timeout = new Promise((_, reject) => {
    watchdog = setTimeout(() => {
      try {
        rec.stop();
      } catch {
        // ignore
      }
      reject(new Error("encode-timeout"));
    }, timeoutMs);
  });
  try {
    el.currentTime = 0;
    rec.start(250);
    pump();
    try {
      // Unmuted first so source audio rides along; muted fallback keeps
      // the conversion valid when autoplay policy blocks sound here.
      try {
        el.muted = false;
      } catch {
        // some browsers need muted capture — video still records
      }
      await el.play();
    } catch {
      try {
        el.muted = true;
        await el.play();
      } catch {
        throw new Error("encode-failed");
      }
    }
    if (onProgress) {
      try {
        const tick = () => {
          if (rec.state === "inactive") return;
          if (dur > 0 && Number.isFinite(el.duration)) {
            try {
              onProgress(Math.min(1, (el.currentTime || 0) / dur));
            } catch {
              // ignore
            }
          }
          setTimeout(tick, 500);
        };
        tick();
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => {
      const end = () => {
        el.removeEventListener("ended", end);
        resolve();
      };
      el.addEventListener("ended", end);
      // Fallback: finite clips always end; guard absurd durations.
      setTimeout(resolve, Math.max(10000, (dur || 10) * 1000 + 8000));
    });
    try {
      rec.stop();
    } catch {
      // already stopped
    }
    await Promise.race([stopped, timeout]);
  } finally {
    pumpOn = false;
    clearTimeout(watchdog);
    try {
      el.pause();
    } catch {
      // ignore
    }
    try {
      for (const t of stream.getTracks()) t.stop();
    } catch {
      // ignore
    }
    try {
      if (audioCtx) await audioCtx.close();
    } catch {
      // ignore
    }
  }
  if (!chunks.length) throw new Error("encode-failed");
  return new Blob(chunks, { type: mime.split(";")[0] });
}

/**
 * Container remux through the vendored ffmpeg build. Tries the classic
 * v0.x global API (window.FFmpeg.createFFmpeg + FS/run) first, then the
 * v0.12+ class API (window.FFmpeg.FFmpeg + writeFile/exec/readFile).
 * Anything unexpected throws — the caller maps it to an honest code.
 */
async function remuxViaFfmpeg(webmBlob, target) {
  const t = String(target || "").toUpperCase();
  const outExt = extForVideo(target);
  const bytes = new Uint8Array(await webmBlob.arrayBuffer());
  const FF = window.FFmpeg;
  // Classic v0.x API.
  if (FF && typeof FF.createFFmpeg === "function") {
    const core = await FF.createFFmpeg({ log: false });
    await core.load();
    core.FS("writeFile", "in.webm", bytes);
    // Stream-copy first (fast, lossless); fall back to default encode.
    try {
      await core.run("-i", "in.webm", "-c", "copy", `out.${outExt}`);
    } catch {
      await core.run("-i", "in.webm", `out.${outExt}`);
    }
    const out = core.FS("readFile", `out.${outExt}`);
    try {
      core.FS("unlink", "in.webm");
      core.FS("unlink", `out.${outExt}`);
    } catch {
      // hygiene is best-effort
    }
    return new Blob([out.buffer || out], { type: VIDEO_MIME_FOR[t] || "video/mp4" });
  }
  // v0.12+ class API.
  if (FF && typeof FF.FFmpeg === "function") {
    const core = new FF.FFmpeg();
    if (typeof core.load === "function") await core.load();
    await core.writeFile("in.webm", bytes);
    try {
      await core.exec(["-i", "in.webm", "-c", "copy", `out.${outExt}`]);
    } catch {
      await core.exec(["-i", "in.webm", `out.${outExt}`]);
    }
    const out = await core.readFile(`out.${outExt}`);
    return new Blob([out.buffer || out], { type: VIDEO_MIME_FOR[t] || "video/mp4" });
  }
  throw new Error("ffmpeg-api-unknown");
}

/**
 * Encode a decoded video handle to target
 * ("MP4"|"WEBM"|"MOV"|"MKV"|"AVI").
 */
export async function encodeVideo(decoded, target, quality, onProgress) {
  const t = String(target || "").toUpperCase();
  if (!decoded || !decoded.el) throw new Error("decode-failed");
  if (t === "GIF" || t === "AVIF") throw new Error("unsupported-target");
  const rung = qualityToRung(quality);
  if (NATIVE_VIDEO_TARGETS.includes(t)) {
    const mime = recorderMimeFor(t);
    if (!mime) {
      throw new Error(t === "MP4" ? "mp4-unsupported" : "webm-unsupported");
    }
    return encodeViaRecorder(decoded, mime, rung, onProgress);
  }
  if (FFMPEG_TARGETS.includes(t)) {
    const failCode = t === "MOV" ? "mov-unsupported" : t === "MKV" ? "mkv-unsupported" : "avi-unsupported";
    const ok = await ensureFfmpeg();
    if (!ok || !hasFfmpeg()) throw new Error(failCode);
    // Remux strategy: record a native WEBM first (same pipeline as the
    // WEBM target), then hand its bytes to the vendored ffmpeg build for
    // container remux only (-c copy where accepted). Re-encoding is left
    // to the native rung-capped recorder, so quality semantics stay
    // identical across all five targets.
    const webmMime = recorderMimeFor("WEBM");
    if (!webmMime) throw new Error(failCode);
    let intermediate;
    try {
      intermediate = await encodeViaRecorder(decoded, webmMime, rung, onProgress);
    } catch {
      throw new Error(failCode);
    }
    try {
      return await remuxViaFfmpeg(intermediate, t);
    } catch {
      throw new Error(failCode);
    }
  }
  throw new Error("unsupported-target");
}

export function extForVideo(target) {
  const t = String(target || "").toLowerCase();
  if (t === "mp4") return "mp4";
  if (t === "mov") return "mov";
  if (t === "webm") return "webm";
  if (t === "mkv") return "mkv";
  if (t === "avi") return "avi";
  return "mp4";
}

/** "clip.mov" + "WEBM" -> "clip.webm". */
export function outNameVideo(srcName, target) {
  const base = String(srcName || "converted").replace(/\.[a-z0-9]+$/i, "") || "converted";
  return `${base}.${extForVideo(target)}`;
}
