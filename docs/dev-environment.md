# Dev environment notes

Practical setup notes for working on this repo — especially in a fresh clone or
an ephemeral container, where the first thing that happens is usually a
misleading wall of test failures.

## Install dependencies first

`node_modules/` is gitignored, so a fresh clone has none. Run this before
trusting any test result:

```sh
npm install
```

Without it, five of the nine checks fail with
`Error: Cannot find module 'playwright-core'`. **This is not a regression** —
it is the browser-driven tests failing to import a dependency that was never
installed. The three pure-Node checks (`decode`, `keys`, `keymesh_check`) and
`tools/keycheck.mjs` pass either way, which makes the split look like a real
breakage in the UI layer when it isn't.

If you hit that error, install and re-run before debugging anything else.

## The full check roster

`npm test` only runs the 2.5D end-to-end test. The key-from-photo work has its
own suite; run all of it:

```sh
node test/decode.mjs           # bitting decode
node test/keys.mjs             # blanks, bitting, warding
node test/keymesh_check.mjs    # CSG mesh
node test/e2e.mjs              # 2.5D end-to-end (browser)
node test/keyui_smoke.mjs      # wizard UI (browser)
node test/orient_smoke.mjs     # key orientation (browser)
node test/bowdetect_smoke.mjs  # bow detection (browser)
node test/rectify_smoke.mjs    # warp-flat skew correction (browser)
node tools/keycheck.mjs all    # CSG geometry checker
```

All nine should pass on `claude/key-from-photo`.

### Which need a browser

`e2e`, `keyui_smoke`, `orient_smoke`, `bowdetect_smoke` and `rectify_smoke`
drive a headless Chromium through `playwright-core`. `keymesh_check` and
`tools/keycheck.mjs` need `manifold-3d` (a normal npm dependency — no browser).

`test/e2e.mjs` finds Chromium by checking, in order: an explicit path argument,
`$CHROMIUM_PATH`, `/opt/pw-browsers/chromium`, then playwright's own default.
In containers that ship a preinstalled Chromium at `/opt/pw-browsers` it is
found automatically — do **not** run `playwright install`, and leave
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` set so npm postinstall doesn't refetch it.
Elsewhere, point `CHROMIUM_PATH` at a local binary.

## Running the app

Browsers block ES modules over `file://`, so the un-bundled source needs a
static server:

```sh
python3 -m http.server 8000     # or: npx serve .
# http://localhost:8000/keys.html
```

## Build and deploy

```sh
node build.mjs                  # or: npm run build
```

Then copy `dist/funny-looking-rock.html` onto the `gh-pages` branch as both
`index.html` and `FunnyLookingRock/index.html`.

Live: https://zillaness.github.io/2.5D/FunnyLookingRock/

## Branching

All key-from-photo work belongs on **`claude/key-from-photo`**. Sessions
sometimes auto-create a suffixed branch (e.g. `claude/key-from-photo-8ke24i`);
those are duplicates and should be deleted rather than developed on. Check
where the real history lives before resetting anything — the remote branch has
at times been ahead of a stale local one of the same name:

```sh
git fetch origin claude/key-from-photo
git log --oneline origin/claude/key-from-photo -1
```

## Things that must never be committed

- The user's key photograph
- The user's real key STL

Test fixtures are synthetic, and `test/shots/` is gitignored.
