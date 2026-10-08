# 🦎 Chameleon

Adapt anything. A file converter homepage in the offline Labs style — full-bleed hairline grid, LabsAmiga display type, directional hover scramble.

> Shell build: the converter UI is a design shell. File queueing works locally; actual conversion is not wired yet.

## Getting started

```
# serve locally (required — @font-face won't load over file://)
python3 -m http.server 5500
# → http://127.0.0.1:5500/index.html
```

No build step, no dependencies — plain HTML, CSS, and JavaScript.

## Project structure

```
chameleon/
├── index.html      # homepage (header, hero, converter shell, marquee, ecosystem, footer)
├── css/style.css   # offline style system (tokens, grid, notch, hover leave-states)
├── js/app.js       # shell wiring (dropzone, picker, chips, queue mock, status)
├── js/scramble.js  # directional hover scramble engine (vanilla, offline-safe)
├── js/convert.js   # conversion stub (support check only for now)
├── assets/         # logo + vendored fonts (LabsAmiga, RobotoMono)
└── preview-style.html  # disposable style showcase (kept for reference)
```

## Style notes

- Display: LabsAmiga 21vh / 89% marquee, vendored in `assets/fonts/`
- Body: RobotoMono, vendored locally, Google Fonts fallback only
- Notch: 10px clip-path (matches live site), orange `#ff7120`
- Hover scramble: left→right on enter (800ms), right→left on leave (~533ms), per-letter fixed-width spans so spacing never shifts
- Title uses uppercase glyph pool; everything else lowercase

## Roadmap

- [x] Homepage shell in offline style
- [ ] Real image conversion (PNG / JPG / WebP, canvas-based, 100% local)
- [ ] Batch download / save button
- [ ] Document conversion stubs

## License

MIT
