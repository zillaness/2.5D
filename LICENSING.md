# Licensing guide

This project is licensed under the **GNU General Public License v3.0 (or later)
WITH the Commons Clause** — a non-commercial, source-available license.

- **Copyleft / share-alike (from GPLv3):** the source is open to inspect, and
  anyone who distributes a modified version must publish their source under the
  same terms.
- **Non-commercial (from the Commons Clause):** you may **not Sell** the
  Software — no selling it, and no paid product/service whose value derives
  substantially from it (including paid hosting or support of it).

Copyright holder: **Projects and Mods**

**Two licenses, split by content type** (the standardized setup):

| What | License | File |
|------|---------|------|
| Source code (software) | GPL-3.0-or-later WITH Commons Clause | `LICENSE` |
| Original artwork, icons, diagrams | CC BY-NC-SA 4.0 | `LICENSE-ASSETS` |

Both are non-commercial + share-alike; they just use the right instrument for
each medium (a software license for code, a Creative Commons license for
creative assets).

> Note: with the Commons Clause added, this is **source-available, not "open
> source"** in the formal OSI/FSF sense (those require allowing commercial use).
> Don't label it simply "GPL-3.0" — always cite "GPL-3.0-or-later WITH Commons
> Clause." (This is not legal advice.)

---

## 1. The `LICENSE` file

`LICENSE` contains the **Commons Clause condition first**, then the full verbatim
GPL-3.0 text. The Commons Clause header names the Software, the base License, and
the Licensor, then the GPL text follows. See this repo's `LICENSE` for the exact
layout; the Commons Clause block is:

```
"Commons Clause" License Condition v1.0

The Software is provided to you by the Licensor under the License, as defined
below, subject to the following condition.

Without limiting other conditions in the License, the grant of rights under the
License will not include, and the License does not grant to you, the right to
Sell the Software.

For purposes of the foregoing, "Sell" means practicing any or all of the rights
granted to you under the License to provide to third parties, for a fee or other
consideration (including without limitation fees for hosting or consulting/
support services related to the Software), a product or service whose value
derives, entirely or substantially, from the functionality of the Software. Any
license notice or attribution required by the License must also include this
Commons Clause License Condition notice.

Software: <your project name>
License:  GNU General Public License v3.0 or later (GPL-3.0-or-later)
Licensor: Projects and Mods
```

Get the GPL-3.0 base text from:
- https://www.gnu.org/licenses/gpl-3.0.txt
- https://raw.githubusercontent.com/spdx/license-list-data/main/text/GPL-3.0-only.txt

---

## 2. Per-file header

There is no clean SPDX identifier for "GPL + Commons Clause," so reference it in a
short notice instead of an `SPDX-License-Identifier` line.

**JavaScript / TypeScript / C / Rust / Go / Java**
```js
// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) — see LICENSE.
```

**Python / Ruby / Shell / YAML**
```python
# Copyright (C) 2026 Projects and Mods
# GPL-3.0-or-later WITH Commons Clause (non-commercial) — see LICENSE.
```

**HTML / Markdown / XML / SVG**
```html
<!-- Copyright (C) 2026 Projects and Mods -->
<!-- GPL-3.0-or-later WITH Commons Clause (non-commercial) — see LICENSE. -->
```

**CSS / SCSS**
```css
/* Copyright (C) 2026 Projects and Mods */
/* GPL-3.0-or-later WITH Commons Clause (non-commercial) — see LICENSE. */
```

---

## 3. Assets (artwork, icons, diagrams) — CC BY-NC-SA 4.0

Code licenses fit code, not pictures. Put **original** visual assets — logo/app
icon, illustrations, diagrams — under **CC BY-NC-SA 4.0** (attribution,
non-commercial, share-alike) in a separate `LICENSE-ASSETS` file.

- Get the full text: https://raw.githubusercontent.com/spdx/license-list-data/main/text/CC-BY-NC-SA-4.0.txt
- `LICENSE-ASSETS` = a short scope header (what it covers, copyright, attribution
  line) + the full CC BY-NC-SA 4.0 text.
- **Attribution line:** `Artwork © Projects and Mods — CC BY-NC-SA 4.0`.
- **Scope carefully.** The assets license covers only artwork YOU created. It does
  **not** cover the source code (that's `LICENSE`) or third-party/reference files
  that carry their own license (e.g. keygen output is CC0; manufacturer
  charts/models keep their own terms). Say so explicitly in the header.

Optional: embed the attribution near where the asset lives (image alt text, an
SVG `<title>`, or a `CREDITS`/`README` line).

## 4. README blurb + badges

```md
## License

- **Code:** [GPL-3.0-or-later WITH the Commons Clause](LICENSE) — non-commercial,
  source-available. You may use, modify, and share the source (modifications stay
  under the same terms), but may **not Sell** the Software.
- **Artwork & diagrams:** [CC BY-NC-SA 4.0](LICENSE-ASSETS) — © Projects and Mods.

Third-party/reference material keeps its own license.
```

Badges:

```md
![Code: GPLv3 + Commons Clause](https://img.shields.io/badge/code-GPLv3%20%2B%20Commons%20Clause-blue.svg)
![Assets: CC BY-NC-SA 4.0](https://img.shields.io/badge/assets-CC%20BY--NC--SA%204.0-lightgrey.svg)
```

Optional badge:

```md
![License: GPLv3 + Commons Clause](https://img.shields.io/badge/license-GPLv3%20%2B%20Commons%20Clause-blue.svg)
```

---

## Notes / gotchas

- **Dependencies:** this works because the bundled deps are permissive
  (Manifold — Apache-2.0, three.js — MIT, earcut — ISC, keygen — CC0). You can
  add the Commons Clause to **your** code and ship those deps under their own
  terms. If a dependency were itself GPL, you could **not** add the Commons
  Clause to the combined work.
- **"Sell" is defined by the clause** (selling the software, or a product/service
  whose value derives substantially from it — incl. paid hosting/support). If you
  ever want to allow a specific commercial use, you (as copyright holder) can
  grant a separate commercial license — dual-licensing.
- The name in the copyright/Licensor line can be any name you choose (a project
  name/handle like "Projects and Mods" is fine — it need not be a legal name).
- **Assets vs code:** keep them in separate files (`LICENSE` for code,
  `LICENSE-ASSETS` for artwork) — see section 3. Don't try to cover images with a
  code license or code with a CC license; use the right instrument for each.
