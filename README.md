# 🦎 Chameleon

**Adapt anything.** A free file converter that runs entirely in your browser. Nothing is uploaded, ever.

🔗 **Live site: [chameleon-tan.vercel.app](https://chameleon-tan.vercel.app)**

---

## Overview

Drop a file in, pick a format, and download the result. Chameleon converts images, audio, documents, and video on your own device, on desktop or mobile.

## Features

- **100% local.** Your files never leave your device.
- **Four media types.** Images, audio, documents, and video.
- **Batch queue.** Convert many files and download them together.
- **Mobile friendly.** Responsive layouts and touch-sized controls.
- **No build step.** Plain HTML, CSS, and JavaScript.

## Supported formats

| Type | Input | Output |
| --- | --- | --- |
| Images | PNG, JPG, SVG, WEBP, HEIC | PNG, JPG, SVG, WEBP |
| Audio | MP3, WAV, OGG, AAC, M4A | MP3, WAV, OGG, AAC, M4A |
| Documents | TXT, MD, RTF, PDF, DOCX, EPUB | TXT, MD, RTF, PDF, DOCX, EPUB |
| Video | MP4, WEBM, MOV, MKV, AVI | MP4, WEBM |

HEIC, MOV, MKV, and AVI are input-only. Scanned PDFs are read with OCR, and the video quality slider runs from 480p to 4K.

## Getting started

There is no build step and there are no dependencies. Serve the folder with any static server, because the fonts won't load over `file://`.

```bash
git clone https://github.com/CodeB3ar/Chameleon.git
cd Chameleon
python3 -m http.server 5500
```

Then open http://127.0.0.1:5500/index.html.

## Project structure

```text
Chameleon/
├── index.html           Homepage
├── convert.html         Converter page
├── faq.html             FAQ
├── css/style.css        Styles
├── js/                  Page scripts, converters, and hover effect
├── assets/              Logo, fonts, and vendored libraries
└── devlog/              Development log
```

## Roadmap

- [x] Homepage
- [x] Image, audio, document, and video conversion
- [x] Batch download
- [x] Mobile support

## Credits

Layout inspired by [cobalt.tools](https://cobalt.tools). Visual style inspired by [ChainGPT Labs](https://labs.chaingpt.org). Built with [pdf.js](https://mozilla.github.io/pdf.js/), [Tesseract](https://tesseract.projectnaptha.com/), [LAME](https://lame.sourceforge.io/), and [ffmpeg](https://ffmpeg.org/).

## License

Released under the [MIT License](LICENSE).
