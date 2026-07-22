# Licensing guide

This project is licensed under the **GNU General Public License v3.0 (or, at your
option, any later version)**. Use this guide to apply the same license to other
files, folders, or repos.

Copyright holder: **Projects and Mods**

---

## 1. Add the license text to the repo

Put the full GPL-3.0 text in a file named `LICENSE` at the repo root. Get the
canonical text from either:

- https://www.gnu.org/licenses/gpl-3.0.txt
- https://raw.githubusercontent.com/spdx/license-list-data/main/text/GPL-3.0-only.txt

(Optional) put a one-line copyright above the license text:

```
Copyright (C) 2026 Projects and Mods

<full GPL-3.0 text follows>
```

GitHub auto-detects it as **GPL-3.0** and shows it on the repo page.

---

## 2. Add a notice to the top of each source file

Pick **one** of the two styles below.

### A) Compact SPDX header (recommended — one/two lines)

```
SPDX-License-Identifier: GPL-3.0-or-later
Copyright (C) 2026 Projects and Mods
```

### B) Full GPL notice (the FSF-recommended block)

```
<name of file/program> — <one-line description>
Copyright (C) 2026 Projects and Mods

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

---

## 3. Paste-ready headers per file type

Use the compact SPDX form in the right comment syntax:

**JavaScript / TypeScript / C / C++ / Java / Rust / Go**
```js
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Projects and Mods
```

**Python / Ruby / Shell / YAML**
```python
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Projects and Mods
```

**HTML / Markdown / XML / SVG**
```html
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright (C) 2026 Projects and Mods -->
```

**CSS / SCSS**
```css
/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright (C) 2026 Projects and Mods */
```

**Lua / SQL**
```lua
-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (C) 2026 Projects and Mods
```

---

## 4. README blurb + badge

Add to a project's `README.md`:

```md
## License

[GPL-3.0-or-later](LICENSE) © Projects and Mods.
This is free software; you can redistribute it and/or modify it under the terms
of the GNU General Public License, version 3 or later.
```

Optional badge:

```md
![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)
```

---

## Notes

- **GPL-3.0 is copyleft:** anyone who distributes a modified version must also
  release their source under GPL-3.0. Good if you want derivatives to stay open.
- The name in the copyright line can be **any** name you choose — a project name
  like "Projects and Mods", a handle, or an org. It does not have to be a legal
  name. Keep it consistent across files.
- Bump the year (or use a range like `2025–2026`) as you keep working.
- If you ever want a *permissive* license for a specific sub-project instead
  (MIT/Apache-2.0), that's a per-repo choice — just swap that repo's `LICENSE`
  and headers; you don't have to match this one everywhere.
