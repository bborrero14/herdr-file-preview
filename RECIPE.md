# RECIPE — file-preview

Use this brief to rebuild the mod from an empty folder. Read
`~/.config/herdr-app/AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts` first: the
installed `.d.ts` files are the source of truth for the API. The notes below record
what the docs leave out, all verified on a real build.

## What to build

`file-preview` is a read-only file browser and previewer.

- A **lazy file tree** of the focused terminal's `cwd`, which follows the focused
  terminal.
- A **preview pane** for the selected file:
  - Markdown: GFM prose, highlighted code fences and Mermaid diagrams as images.
  - Highlighted source for JS/TS, Bash, Python, C, Go, JSON and YAML. JSON is always
    soft-wrapped.
  - Plain text for anything else.
- **Live reload**, in local and remote spaces.
- **Two modes:**
  - **Popup:** `mod.json` overlay `{ "kind": "dialog", "width": 0.95, "height": 0.95 }`
    with `focusable: true`, opened with `cmd-e` → `mod.open:file-preview`.
  - **Right panel**, at 45 % of the tab: a pane created with `pane.split`, opened with
    `cmd-shift-e` → `mod.open:file-preview-panel`, a separate launcher mod.
- **UI text in English.** Use only `theme()` colors. The syntax palette must be hex,
  derived from the theme:
  `{ keyword: ansi5, string: ansi2, comment: dim, function: ansi4, type: ansi3, number: ansi1, constant: ansi6 }`.

Deliver:

- `mods/file-preview/`
- `mods/file-preview-panel/`
- `keys.json` with both shortcuts under `"global"`
- `scripts/sync.sh` to copy the mods into `~/.config/herdr-app/mods/`

## Architecture

```
mods/file-preview/
  mod.json      place none, focusable, dialog overlay at 95 %
  main.js       View: layout (top bar, tree, preview column, status bar), modes, context, keys,
                live reload, block rendering, nextCommand() dev hooks
  tree.js       Tree state (entries Map, expanded Set, selected, cursor), listing via exec("sh", …, {on})
  source.js     read + binary check (NUL) + 1 MB truncation + stat stamp for polling
  markdown.js   segment(text) → [{md}, {code, lang}, {mermaid}, …] (fence scanner)
  lang.js       extension / fence info → Editor language id, label, wraps(), wrappedRows()
  mermaid.js    mmdc + browser lookup, one-at-a-time render queue, .cache/, IHDR size, sizes.json, prune
  dock.js       anchor terminal, pane.split + 45 % sizing, panel toggle
  icons/*.svg   own icons (folder, folder-open, file, file-md, file-code, chevrons, reload, anchor, close)
mods/file-preview-panel/
  mod.json      { place: none, overlay: { kind: popup, width: 1, height: 1, frame: none } }
  main.js       Launcher View: init() { try { toggle() } finally { if (overlay) closeOverlay(overlay) } }
  dock.js       byte-for-byte copy of mods/file-preview/dock.js
```

**Context** works like the shipped `files` mod's `location()`:

- `cwd` = the focused pane's `cwd`, else `focused().cwd`, else `space.folder`.
- `on` (machine) = the active space's `machine`. For a layout terminal block, it is the
  `<machine>/` prefix of `focused().terminal`.
- Key the context as `JSON.stringify([cwd, on])`. In `render`, if the key changed,
  store it **synchronously** and `cx.spawn` the reload. Spawning from `render` works,
  and the key guard prevents a render loop.

**Tree:** list one folder per call with a POSIX `sh -c` script:

- NUL-separated `d|f<name>` entries
- skip `.git`
- `-d` follows symlinks
- head at 500 entries

Sort folders first, then `localeCompare`. Cap the tree at 5000 entries in total. Use a
virtual list (`v_virtual_list`) with 22 px rows, and keyboard handling on its own focus
handle.

Tree keys:

| Key | Action |
|---|---|
| ↑ ↓ Home End PgUp PgDn | Move the cursor |
| → | Expand, or step into the folder |
| ← | Collapse, or go to the parent |
| Enter / Space | Open the file or toggle the folder |
| Tab | Switch focus between tree and preview |
| `r` | Reload |
| `b` | Fold or unfold the tree in a narrow panel |
| Esc | Close the popup |

Ignore keys that carry platform, control or alt modifiers.

**Dev hooks:** `nextCommand()` accepts the same keys as `file-preview.<key>`, plus
`reload`, `anchor`, `retry-diagrams` and `open:<path>` (relative to the root, or
absolute). These hooks make the mod testable with `herdr-app do` and `herdr-app shot`,
with no keyboard or pointer automation.

## Platform gotchas (all learned the hard way)

### Markdown and code

- **`TextView.markdown` draws GFM well but does NOT highlight fenced code.** Segment the
  document instead:
  - Prose segments go to `TextView.markdown(id, text)`, with stable ids `md-<i>`.
  - Each fence becomes a **read-only `Editor`** with `line_numbers: false`,
    `folding: false`, `font_size: 12`.
  - Give each fence editor an explicit height of **`rows × 19 + 8` px**. Without one,
    the Editor collapses to about 2 lines; it has no minimum height.
  - Create `EditorState`s in `init`, handlers or `cx.spawn`, never in `render`.
    `release()` them when the file or theme changes, and in `close()`.
  - Cap the number of editors (about 300). Fences past the cap stay plain prose.
- **Fence scanner rules:**
  - Fences open with ```` ``` ```` or `~~~` of length ≥ 3, and close with the same
    marker of at least the opening length.
  - The info string is the first word.
  - Ignore fences inside 4-space indented code.
  - An unclosed fence runs to the end of the document.
- **Verified Editor language ids:** `js`, `javascript`, `bash`, `sh`, `python`, `py`,
  `c`, `go`, `json` and `yaml` highlight. **`shell` and `golang` do NOT.** Normalize
  aliases first:

  | Alias | Id |
  |---|---|
  | `shell`, `zsh`, `console` | `bash` |
  | `golang` | `go` |
  | `h` | `c` |
  | `pyi` | `python` |
  | `ts`, `tsx`, `jsx`, `mjs`, `cjs`, `typescript` | `js` |
  | `jsonc`, `jsonl`, `ndjson`, `json5`, `geojson` | `json` |
  | `yml`, `toml` | `yaml` |

  `html` and `css` probably work too; they are unverified.
- **JSON soft wrap:** JSON is often one minified line, so JSON files and fences use
  `soft_wrap: true`. A fence's height must then count **visual rows**:
  - The Editor breaks a row **before `{` or `[`, or after a space**. With no such
    point, it breaks mid-token. Skip the leading spaces of each continuation.
  - Columns: `cols = floor((colW − 24) / (12 × 0.6))`. The character width is 7.2 px,
    and the Editor leaves about 20 px without text; 24 px is the safe pad.
  - Measure `colW` with `on_size_change` on the preview column, which has a max width
    of 860 px.
  - When the width changes, recompute only the height (cache it per `cols`). Don't
    rebuild the `EditorState`.

### Mermaid

- **Render locally with mermaid-cli to PNG, not SVG.** Mermaid's SVG puts labels in
  `foreignObject`, which the native SVG renderer doesn't draw.
- **`exec` has a minimal PATH**, without Homebrew or fnm, so `exec("mmdc")` usually
  fails. Resolve `mmdc` once per mod instance, lazily (on the first uncached diagram),
  and remember failures too:
  1. a `MMDC` constant (absolute path);
  2. **fnm's stable default alias**, `~/.local/share/fnm/aliases/default/bin/{node,mmdc}`,
     run as `exec(node, [mmdc, …])` so the shebang doesn't matter;
  3. `command -v mmdc` on the minimal PATH;
  4. a login shell (`fish -lic` / `$SHELL -lic` `command -v mmdc`). With fnm this
     returns an ephemeral `fnm_multishells` path.
- **mmdc ships no browser.** Find one:
  - `$PUPPETEER_EXECUTABLE_PATH`
  - Chrome, Chromium, Brave or Edge in `/Applications` and `~/Applications`
  - `google-chrome`, `google-chrome-stable`, `chromium` or `chromium-browser` on Linux

  Write `.cache/puppeteer.json` = `{ "executablePath": <browser>, "headless": "shell" }`
  and pass it with `-p`. Full command:
  `-i in.mmd -o out.png -t default|dark -b transparent -s 2 -q -p puppeteer.json`.
- **`exec` resolves even when the process fails.** Check `r.code === 0` and read
  `r.stderr`. Show a trimmed error: no stack, at most 8 lines or 600 characters.
- **Never call `image(path)` before the PNG exists.** The image cache remembers the
  missing file as blank forever. Check existence first, or change the file name per
  attempt.
- **PNG size:** read the file with `fs.readFile` with no encoding, which returns a
  `Uint8Array`. Width is at byte 16 and height at byte 20, big-endian, from the IHDR
  chunk.
  - Draw with `image(rel).w(min(colW, pngW / 2, 600))`, keeping the aspect ratio.
    Never use `h()` or `w_full()` on the image.
  - Put it in a box with an explicit height, so the layout doesn't jump while the image
    decodes.
  - Save sizes in `.cache/sizes.json` (key → `{w, h}`). A re-render's "Rendering
    diagram…" placeholder then gets the final height.
- **Cache:**
  - Key = `fnv1a(source + "|" + theme)`.
  - Files: `~/.config/herdr-app/mods/file-preview/.cache/<key>.{mmd,png}`. `image()`
    takes the path relative to `~/.config/herdr-app`.
  - The folder must be **hidden** (`.cache`). Any visible write inside a mod folder
    hot-reloads the mod.
  - If the PNG is cached, show it without resolving any tools.
  - When the mod starts, prune to the 200 newest PNGs by mtime. `touch` a PNG on a
    cache hit to keep the order LRU.
- **Render queue:**
  - One render at a time; each starts a Chromium.
  - After 20 s, show a fallback. `exec` can't be killed, so wait for it before starting
    the next render.
  - Tie each result to the current context, the current file and the block object.
    Identical diagrams share one render.
- **Fallback:** show the diagram source in an Editor under a notice:
  - yellow (`ansi3`) when `mmdc` or the browser is missing, with **Retry** (forget the
    resolution and re-request);
  - red (`ansi1`) with the trimmed stderr for a broken diagram, with **Retry**.

### Panel and launcher

- **A key binding can't pass `mod`/`props` to `pane.split`**: `command:value` fills only
  the first argument. The fix is a launcher mod. Its `mod.json` is an invisible popup
  overlay (`frame: "none"`). Its `init` docks or undocks the panel, then closes its own
  overlay.
  - Read `props()`, not `init`'s argument, which arrives `undefined`.
  - **Guard `closeOverlay`:** `herdr-app check` runs `init` with no window, so
    `props().overlay` is null, and `closeOverlay(null)` throws.
- **Mods import only from their own folder**, so `dock.js` is duplicated in both mods.
  Make the sync script refuse to run when the copies differ.
- **`focused()` in the launcher's `init`** is still the terminal behind it. After
  `pane.split`, focus moves to the new pane, so pass `cwd`, `on` and the anchor
  terminal's pane id in `props`.
- **45 % width:**
  - The new pane is NOT yet in `panes()` inside the launcher's `init`. The panel sizes
    itself on its **first `on_size_change`**.
  - Find its own pane: the `mod === "file-preview"` pane that is `focused`, else the
    tab's panel.
  - Sizing: `layout.resize {id: anchorTerminal, weight: 0.5}`, **then**
    `layout.resize {id: panel, weight: 0.409}`, since `0.5 × 45 / 55 ≈ 0.409`.
  - Weights are relative between siblings, so an earlier user resize of the terminal
    skews the result unless you reset the terminal first.
  - This only gives 45 % when the terminal is alone in its row. No API exposes the
    split tree.
- **Narrow panel** (under 600 px, which 45 % usually is): the tree folds to a 28 px
  strip with a toggle button and key `b`.
  - When unfolded, the tree is `min(220, 55 % of the width)`.
  - It starts unfolded, unless `props.file` was passed by the popup's anchor button.
- **One panel per tab:** a mod can't learn its own pane id or update an existing pane's
  props. The toggle and ✕ find the tab's panel with
  `panes().find(p => p.tab === tab && p.mod === "file-preview")`. Anchoring closes it
  and splits a new one.
- **Follow the terminal, not the mod:** accept a new context only while a **terminal**
  is focused. Ignore focus on this mod's own pane or on other mods; otherwise clicking
  the panel jumps the root to `space.folder`.
  - Initial context, in order: `props.cwd`/`props.on`; the focused terminal; else the
    tab's first terminal.
  - A remote space with no folder uses the remote `$HOME` (`sh -c 'printf %s "$HOME"'`).

### Live reload

- **`watchFolder(dir)` works only locally.**
  - Local: loop on `await watchFolder(root)`. Treat paths outside the root as "the
    whole root" (on macOS, `/private/tmp` vs `/tmp`). Reload the file if the event names
    it or its folder.
  - Remote: `cx.timer.every(2500)` with
    `stat -c "%Y %s" "$1" || stat -f "%m %z" "$1"` through `exec(…, {on})` for the open
    file; `every(10000)` for the expanded folders.
  - Debounce 200 ms, with at most 1 s of waiting.
- **Patch in place** when the block structure is unchanged: same id for each `TextView`,
  and `state.set_value()` for each Editor. Rebuild only when the structure changes.
  Scroll position can't be read or set (only virtual lists have a handle). Keep ids
  stable and let GPUI keep it.
- `readTextFile(path, {on})` returns `null` for a deleted file instead of throwing.
  Show "This file no longer exists".
- Tell a remote machine being **offline** apart from a folder error. Keep the last tree,
  show a notice with Retry, and label the machine `<machine> · offline`.

### Other traps

- **Don't let a callback parameter shadow an import.** An `on_size_change((size) => …)`
  shadowed the imported `size()` from `dock.js`. The resulting exception also broke the
  width measurement. Name the parameter `box`.
- **Install by copying, never by symlink.** With a symlinked mod folder,
  `herdr-app check` passes and the mod runs, but **no `svg("mods/<name>/icons/…")`
  draws**, because the asset loader doesn't follow the link. Herdr also doesn't write
  `jsconfig.json` or `gpui-kit.d.ts` into a symlinked folder.
  - The sync script: `rsync -a --delete --exclude .cache/ --exclude jsconfig.json --exclude gpui-kit.d.ts`.
  - It removes any old symlink first, because rsync would otherwise write through it
    into the repo.
- **Debugging:**
  - `console.log` goes nowhere. Paint state into the status bar, or dump JSON into the
    hidden `.cache/`.
  - `herdr-app check` runs `init` headless: `focused()` is null and spawned tasks don't
    finish. Always verify with `herdr-app shot`.
- **Paths:** the mod hardcodes `mods/file-preview/` for icons and the cache. If you
  rename the mod, update those paths and the `"file-preview"` mod name in `dock.js`.

## Test fixtures

`docs/fixtures/` has:

- `all-langs.md`: a fence per language and alias, a wrapped minified-JSON fence,
  Mermaid, a table and task lists
- `mermaid.md`: flowchart, sequence, class, a broken diagram and identical twins
- `tables.md`
- `sample.{js,sh,py,c,go,json,yaml}`
- `sample.min.json`: about 5 KB on one line
- `big.md`: over 1 MB, generated by `scripts/make-big-md.sh` (not versioned)
- `tiny.png`: binary
