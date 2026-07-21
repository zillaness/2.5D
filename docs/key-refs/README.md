# Key reference drop folder

Drop source material here that the build environment **can't fetch itself** — the
agent proxy 403s the authoritative locksmith / manufacturer PDFs (Framon, LSA
Michigan, Master Lock's own CDN), so the depth-and-spacing numbers in
`js/keys/blanks.js` are currently triangulated from secondary sources instead of
one canonical chart. Files you commit here let those numbers get **confirmed**
(and let provisional blanks like Master Lock **M1** graduate to `verified: true`).

## How to use it

1. Grab an item from **[`PULL-LIST.md`](./PULL-LIST.md)** (prioritized).
2. Save it into this folder and commit it on `claude/key-from-photo`.
3. Tell me it's here — I'll read it, update `blanks.js`, flip `verified`, and note
   the source in the commit.

## What to drop

Anything readable helps:

- **PDFs** — official charts / technical manuals (best: they're authoritative).
- **Photos / screenshots (PNG/JPG)** of a printed depth-and-spacing chart.
- **STL / STEP** — e.g. a key you generate on an online keygen for a known code;
  I can measure the warded cross-section off the solid.
- **SVG / DXF** — a traced keyway cross-section (blade width, thickness, side
  grooves), the "make-or-break" warding data that's hardest to source.

## Naming

Keep it obvious so I can map file → blank:

```
<KEYWAY>_<what-it-is>_<source>.<ext>
SC1_depth-and-spacing_framon.pdf
M1_technical-manual_masterlock.pdf
KW1_cross-section_keygen.stl
```

## The self-bootstrapping loop (your idea)

Once decoding works end-to-end: cut a known code → generate that key on a keygen →
export its STL → drop it here → I read the **warded cross-section** off it → that
profile goes back into `blanks.js`. Each keyway you round-trip this way upgrades
the library from "prints a geometry proof" to "prints a key that actually enters
the lock."

## Scope reminder

Ordinary residential/padlock blanks only. Do **not** drop restricted, patented,
registered, or "Do Not Duplicate" keyways (Medeco, Abloy, Mul-T-Lock, etc.) —
they're out of scope for this tool.
