MP4 + WEBM + MOV + MKV + AVI Support
Oct 11, 2026 — Chameleon now converts video alongside images, audio and documents. All five formats decode in-browser and re-encode on-device with no uploads: <video> decode plus a canvas + MediaRecorder pipeline for MP4/WEBM, and an opt-in vendored ffmpeg remux for MOV/MKV/AVI.
• MP4/WEBM encode natively through a rung-capped canvas captureStream — no browser ships MOV/MKV/AVI recorders, so those remux a native WEBM through ffmpeg
• ffmpeg is strictly on demand (user-supplied drop-in under assets/vendor/ffmpeg/, never preloaded, never CDN) — declining it keeps MP4/WEBM working
• Quality slider maps to resolution rungs (480p · 720p · 1080p · 2K · 4K, never upscale) with a per-rung bitrate hint; every video target respects it
• Source audio rides along via MediaStreamDestination where the browser allows it; silent output is still a valid conversion
• Every failure names itself (mp4-unsupported, mov-unsupported, encode-timeout…) in the Download view
• supportsVideoTarget gates output per browser while MOV/MKV/AVI always show INPUT ONLY (input is attempted for every file; no canPlayType probe — it under-reports containers browsers still play); single-card preview plays a muted inline <video> thumb
