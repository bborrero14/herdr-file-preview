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
  - Markdown: GFM prose, highlighted code fences (each with its language and a copy
    button) and Mermaid diagrams as images.
  - Highlighted source for JS/TS, Bash, Python, C, Go, JSON and YAML. JSON is always
    soft-wrapped.
  - Plain text for anything else.
- **Live reload**, in local and remote spaces.
- **Commit history** in a Files | Commits sidebar tab: a GitLab-style graph (lanes,
  merge/fork curves, nodes, ref flags at the node), a commit view (header, files, tinted diff) and
  files as of a commit through the normal preview.
- **Git change marks** (VS Code style): status letters and colors in the tree, changed
  blocks in Markdown, a line gutter (or an overview ruler) in the code view.
- **Hide/show the tree** at any width (top-bar button, key `b`), remembered per mode.
- **Reading zoom** (70–200 %): prose, fences, code view and diagrams scale together;
  keys `+`/`=`, `-`, `0`, top-bar buttons A− / % / A+, remembered per mode.
- **Expanded diagrams**: an expand button on each diagram; fit, zoom `+`/`-`/`0`, two-axis
  scrolling, and a sharper re-render when zoom would upscale.
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
  git.js        read-only git: status → tree letters and folder tints; diff -U0 HEAD → changed lines
  commits.js    read-only history: paged git log, refs checksum, lane assignment (Graph), git show of one
                commit (name-status, numstat, patch, caps), a file at a revision, date formats
  graph.js      one graph cell per commit row: PathBuilder strokes per lane color, the node, the ref-flag pointer (pure)
  find.js       file list (git ls-files or find) + fuzzy ranking; document matches, headings; key contexts
  memory.js     popup memory per root: { file, expanded } in shared("file-preview.memory"), LRU of 20
  mermaid.js    mmdc + browser lookup, one-at-a-time render queue, .cache/, IHDR size, sizes.json, prune
  zoom.js       Zoom: the expanded diagram (fit, zoom steps, viewport, -s 4 swap) and its keys
  dock.js       anchor terminal, pane.split + 45 % sizing, panel toggle
  icons/*.svg   own icons (folder, folder-open, file, file-md, file-code, chevrons, reload, anchor, close,
                sidebar, expand, zoom-in, zoom-out, fit, deleted, search, search-doc)
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
| `b` | Hide or show the tree (any width) |
| `/`, `cmd-f` | Open the file search (tree) or the document search (preview) |
| Esc | Close the popup |

Ignore keys that carry platform, control or alt modifiers.

**Dev hooks:** `nextCommand()` accepts the same keys as `file-preview.<key>`, plus
`reload`, `anchor`, `retry-diagrams`, `open:<path>` (relative to the root, or
absolute), `expand:<n>` (n-th diagram, from 0), `zoom-in`, `zoom-out`, `zoom-fit`,
`zoom-close`, `text-in`, `text-out`, `text-reset` (reading zoom), `copy:<n>` (the n-th code box's copy button, from 0; check with
`pbpaste`), `tree-reset` (forget this mode's stored tree choice), `memory-forget[:<key>]`
(drop the popup's memory of this root, or of the given root key), and the search hooks: `tree-find:<q>`,
`doc-find:<q>`, `find:<q>` (the pane with the keyboard), `find-next`, `find-prev`,
`find-enter` (open the selected result), `find-close` and `find-esc` (dispatches the Esc
action down the focus path, as the bound key would), and the history hooks: `tab:files`,
`tab:commits`, `commits-scope`, `commits-more`, `commit:<row | hash prefix>`,
`commit-file:<n>`, `commit-back`, `commit-close` and `copy-hash`. Key names (`down`,
`enter`, …) go to the commit list while the Commits tab shows. These hooks make the mod testable with `herdr-app do` and `herdr-app shot`,
with no keyboard or pointer automation.

## Platform gotchas (all learned the hard way)

### Markdown and code

- **`TextView.markdown` draws GFM well but does NOT highlight fenced code.** Segment the
  document instead:
  - Prose segments go to `TextView.markdown(id, text)`, with stable ids `md-<i>`.
  - Each fence becomes a **read-only `Editor`** with `line_numbers: false`,
    `folding: false`, `font_size: 12`.
  - **Editor metrics** (measured at 12, 13, 14, 16 and 18 px): line height is
    `round(font × 1.618)` (GPUI's phi: 19, 21, 23, 26, 29), a mono char is
    `font × 0.6` wide, and text starts flush with the Editor's top edge (no padding).
    Derive every height from the font size; don't hard-code 19.
  - **A code Editor always scrolls past its end** by `max(height / 2, 3 rows)`. There is
    no option to turn it off, so a box sized to the text still scrolls on the wheel
    until it shows nothing. Fix: a box of exactly `rows × lineHeight` with
    `overflow_hidden()`, holding the Editor at `text + max(text, 3 × lineHeight)`.
    At that height its max scroll is 0, so it never moves vertically, doesn't take the
    wheel, and the document scrolls instead. Selection and copy still work (nothing
    sits on top). Put the padding outside the clipped box (`py(6)`). The cost is that
    the Editor's horizontal scrollbar lands in the clipped part. Don't size the box as
    `rows × 19 + 8`: the 8 px end up as a blank band under the last line.
  - Without an explicit height the Editor collapses to about 2 lines; it has no
    minimum height.
  - **Copy button:** a header row with the normalized language name and a copy button.
    `cx.write_to_clipboard(text)` with the fence body only (no fence lines, no
    trailing newline), then "Copied" with a check icon for 1.5 s via one
    `cx.timer.after`. Keep a counter on the block so a second click restarts the 1.5 s.
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
  - Columns: `cols = floor((colW − 24) / (font × 0.6))`. The Editor leaves about
    20 px without text; 24 px is the safe pad (checked at 12, 14 and 16 px). Err toward
    one row too many: the clipped box would hide a row that was not counted.
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

### Tree visibility

- `b` and a sidebar button at the left of the top bar hide or show the tree at any width.
  Hidden, the tree leaves the same 28 px strip (with a folder button) as a narrow panel.
- **`localStorage` is per mod copy**, and every popup is a new copy, so it forgets. Store
  the choice with `setShared("file-preview.tree.<popup|panel>", bool)` (persisted in
  `shared.json`); read it once in `init` so open copies in other tabs don't flip.
- With nothing stored: shown, except a narrow panel keeps its launch default (shown;
  folded after the popup's anchor). A stored choice wins at every width.

### Popup memory per root

- Popup only (a copy with `props().overlay`); the panel is long-lived and keeps today's
  behavior. One shared value, `setShared("file-preview.memory", { entries: { [key]: { file,
  expanded: [...], at } } })`, with `key` = the root (local) or `<machine>:<root>` (remote).
  Keep the 20 most recent roots by `at`; store at most 200 folders, shallowest first (a
  cut then keeps every kept folder's parents). An empty state drops its entry.
- **Restore before the first listing**: put the saved folders and the saved file's parents
  in `tree.expanded` right after creating the tree, so the root's first `reload()` lists
  them all, parents first, and drops the ones that are gone. When that listing has loaded
  the root, open the file only if its parent's entries contain it (`show(…, {keep: true})`),
  else collapse the parents it added; then set the cursor and
  `scroll.scroll_to_item(i, "center")`.
- **Don't store before the restore finished**: `start()` shows nothing first, which would
  overwrite the memory with an empty state. A `ready` flag gates every write.
- **Write on change, not on close**: `close()` has a 250 ms budget and may not run (a hot
  reload re-inits the copy without it). Expand, collapse and opening a file arm a 500 ms
  `cx.timer.after`; the flush compares a JSON signature with the last write, so renders
  and repeated calls cost nothing. `close()` and a root change flush at once.
- `setShared` re-renders every mod: never call it from `render`.
- Normalize `open:` paths (`a/../b`): otherwise `reveal` expands, and the memory keeps, a
  folder named `a/..`.
- The document's scroll position can't be restored: overflow containers can't be
  scrolled from a script.

### Expanded diagrams

- **Popup: draw your own layer, not a new overlay.** A `window` overlay draws *under*
  dialogs. Render the layer *instead of* the popup's content: gpui-kit has no
  `occlude()`, so an absolute layer over the document would let presses, hovers and
  wheel events reach the tree and the document under it. EditorStates stay retained;
  only the document's scroll position is lost.
- **Panel: `openOverlay({ kind: "dialog", width: 0.95, height: 0.95, mod: "file-preview", props: { mode: "diagram", diagram, label } })`.**
  The same mod in a third mode: `init` returns early (no tree, context, watchers or
  prune) and `render` draws only the viewer. Every visible copy gets `file-preview.*`
  commands, so each copy ignores the ones that aren't for it.
- **Esc:** the app handles Esc first and closes the popup's dialog before the layer's
  `on_key_down` sees it, so `cx.stop_propagation()` is not enough. Bind it yourself, scoped
  to the layer: `cx.bind_keys([{ keystroke: "escape", action, context }])` once in `init`,
  then `.key_context(context).on_action(action, (e, cx) => close())` on the focused layer
  root (the shipped `win98` menu does the same). A deeper binding wins over the app's.
- **Viewport:** `div().flex_1().min_h(0).relative()` holding the scroll area
  `div().id(name).size_full().overflow_scroll()` (measured with `on_size_change`) and
  `Scrollbar.new(name).absolute().inset_0()`. Inside the area, a box of
  `max(viewport, image + 2 × 24)` per axis that centers `image(path).w(W)` (again no `h()`).
  Not `overflow_scrollbar()`: there the wheel scrolled only horizontally even though the
  content measurably overflowed both axes (5339 × 2022 in a 1434 × 870 viewport), so the
  layout was not the cause. Plain `overflow_scroll()` is GPUI's own both-axis scrolling;
  the paired `Scrollbar` paints both bars (shown while scrolling, per the theme).
  Fit = `min(availW, availH × w / h)`; zoom = fit × 1.25ⁿ, clamped to 0.25–8. Show
  `W / (pngW / 2)` as the percentage.
- **Sharper render:** when `W × 2` (device scale; no API reports it) exceeds the PNG's
  pixel width, request the same source at `-s 4` once, under the key `<key>-s4` (so the
  `-s 2` keys don't change), and switch `image()` to it only when the render's answer
  says the file exists. Cap at 4. A wheel or trackpad zoom with `on_scroll_wheel`
  is possible but not done.

### Reading zoom

- **One level `z`** from `[0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]`. Only the document
  scales: top bar, tree, status bar and fence headers keep their size.
- **Prose:** `.text_size(round(13 × z))` on the Markdown column. `TextView.markdown`
  inherits it, and its headings, tables and inline code scale with it. Don't use
  `window().set_rem_size()`: it rescales the whole window.
- **Code:** `font_size = round(12 × z)`, and every height from the Editor metrics above
  (`round(f × 1.618)` rows, `f × 0.6` columns, 24 px wrap pad). Measured exact at 80, 100,
  150 and 200 % (plain and wrapped JSON fences). Scale the fence's vertical padding too,
  `round(6 × z)`, so the margin around the text stays proportional.
- **`EditorState` has no font-size setter** (only `set_value`). On a level change, create
  new states on the existing blocks and release the old ones (in the handler, never in
  `render`); keep the blocks, so diagrams keep their render and live-reload patching still
  works. Drop the cached wrapped-row counts.
- **Diagrams:** width `min(colW, pngW / 2 × z, 600 × z)`, through the same function as the
  placeholder, so nothing jumps. Above 100 % the `-s 2` PNG is upscaled (slightly soft).
- **Keys** without modifiers on the tree and preview handlers: `+` or `=` in, `-` out, `0`
  reset. The expanded diagram has its own focus handle and its own `+ − 0`, so the two
  never mix.
- Persist per mode like the tree: `setShared("file-preview.zoom.<popup|panel>", z)` (`null`
  at 100 %), read once in `init`. The diagram-mode copy ignores it.

### Git change marks

- **One `sh -c` script per question**, run with `exec(…, { on })`, so a remote space costs
  one round trip. `command -v git` first (exit 4: no git), then everything through
  `git -C "$root"` with
  `--no-optional-locks -c core.fsmonitor=false -c core.quotepath=off -c diff.autoRefreshIndex=false`.
  **Without those flags `git status` refreshes `.git/index`**: the folder watch sees the
  write and starts the next refresh, forever. Verified: `.git/index` keeps its mtime
  while the 5 s poll runs.
- **Tree:** `git rev-parse --show-prefix`, a NUL, then
  `git status --porcelain=v1 -z --untracked-files=all`. Porcelain paths are relative to
  the repo top; strip the prefix to get root-relative paths. Use the prefix, **not**
  `--show-toplevel` string math: on macOS `/tmp` is `/private/tmp`, so the root and the
  top don't share a string prefix. Not a work tree (exit 5) → no decorations.
  - XY → letter: `??` U; any `U`, or `AA`/`DD` → `!`; any `D` → skip (not on disk);
    `A`/`R`/`C` in X → A; else M. With `-z`, a rename or copy is followed by the old
    path as its own field: skip it.
  - Folders: walk each changed path's parents and keep the strongest letter
    (`!` > M > A/U), stopping once a parent already ranks as high.
  - Cap the entries (20,000) for a huge untracked folder.
- **Document:** `git status --porcelain -z -- <file>`, `\1`, `H` or `N`
  (`rev-parse -q --verify HEAD`), `\1`, then `git diff --no-color --no-ext-diff
  --no-textconv -U0 HEAD -- <file>` (staged and unstaged at once). Untracked, or no
  HEAD yet → every line added. A staged rename limited to the new path diffs as a new
  file, which is what the tree shows (A). Hunks `@@ -a,b +c,d @@` (a missing count is
  1): `d = 0` → deletion after line `c`; `b = 0` → `c…c+d−1` added; else modified.
  `-U0` folds a deletion next to a change into one modified hunk.
- **Refresh:** status on start, after every tree refresh (watch events, remote polls),
  on watch batches that touch only `.git` (a stage or commit), and every 5 s
  (`cx.timer.every` in the context's tasks). Single-flight per context: a request while
  one runs sets a flag and runs once after. An unreachable machine keeps the last
  marks. Re-run the file's diff only when its status letter changes or its content
  reloads; an untracked file needs no exec at all.
- **Markdown:** `segment()` returns `start`/`end` (source lines from 1, inclusive) for
  each prose chunk (`chunks()` reports each piece's first line) and fence (with its
  fence lines). Wrap every block in `v_flex().w_full().relative()` and draw the marks
  **absolutely in the column's side padding** (`left(-8)`, 3 px wide, `top(0).bottom(0)`):
  no layout change with or without a repo. Bar color: added `ansi2`, modified or mixed
  `ansi4`. A deletion after line n goes to the first block ending at or below n: its
  bottom when n is its last line, else its top; past the last block, the last block's
  bottom. Deleted-lines marker: a filled triangle SVG (`currentColor`) in `ansi1`.
- **Code view, line gutter (≤ 1,000 rows):** the Editor scrolls itself and its scroll
  position can't be read, so a sibling gutter can't follow it. Lay it out at full height
  instead (the fence trick): a box of `rows × round(f × 1.618)` with `overflow_hidden()`,
  the Editor inside at `text + max(text, 3 rows)`, all inside an `overflow_y_scrollbar()`
  container next to an 8 px gutter of absolute bars (`top = (line − 1) × lh`). The Editor's
  text starts flush at its top, so marks align at every zoom (checked at 100, 150 and
  200 %). Rows = `\n` count + 1 (a trailing newline shows an empty last row).
  - **Cost:** the Editor lays out every row each frame at full height. Measured as the
    gap between `cx.timer.every(1)` ticks that each `cx.notify()` (8 ms idle at 120 Hz):
    300 rows 8.7 ms, 1,000 rows 16 ms, 2,000 rows 46 ms, 8,000 rows 650 ms. The normal,
    self-scrolling Editor stays at 8 ms for 8,000 rows. Hence the 1,000-row cap.
  - Costs of the full-height layout: the Editor's horizontal scrollbar is in the clipped
    part (trackpad still scrolls sideways), and keyboard cursor moves don't scroll the
    outer container. So it is used only inside a repo; elsewhere the code view is the
    plain Editor, as before.
- **Code view, overview ruler (> 1,000 rows, or soft-wrapped JSON):** an 8 px strip right
  of the Editor with markers at `top: (line − 1) / rows %` and `h: n / rows %`, `min_h(2)`.
  Markers in the lower half hang from `bottom(%)`, so the 2 px minimum never overflows
  the strip (a marker at the last row was invisible with `top`).

### Commit history

- **Tabs:** `Files | Commits` over the sidebar, only while the git status says the root is
  in a repo (`this.git` non-null). The choice lives in `shared("file-preview.sidebar.<mode>")`
  ("commits" or null); the effective tab is `side === "commits" && git ? "commits" : "files"`,
  so a non-repo root shows Files without losing the preference. The commit list has its
  own focus handle; when the tab comes or goes with the repo, move the keyboard with it
  (in the git refresh handler, not in `render`). Wide view: the sidebar grows to
  `min(460, 40 %)` on the Commits tab; narrow view: the usual 220 px.
- **Log:** one `sh -c` (same read-only flags as the status) printing a refs checksum,
  `\1` HEAD `\1` remotes `\1`, then `git log <refs> --topo-order -z
  --format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s --skip=N -n 301`. Refs: `--branches
  --tags --remotes HEAD`, **not `--all`** (that drags in `refs/stash`); "current branch" is
  `HEAD`. Ask for one more than the page to know whether there is more. Exit 6 (no
  `rev-parse --verify HEAD`) → "No commits yet". `%D`: `HEAD -> x` is the current branch,
  `tag: x` a tag, `<remote>/x` a remote (from `git remote`), `*/HEAD` dropped.
- **Paging:** `--skip` continues the same topological order, so lanes carry over between
  pages. If the checksum changed between pages, reload in full instead. A refresh loads
  `max(300, loaded)` in one call and rebuilds the lanes; the selection is kept by hash.
- **Refresh:** the checksum is `{ rev-parse -q --verify HEAD; symbolic-ref -q HEAD;
  for-each-ref --format=%(objectname)%(refname) refs/heads refs/tags refs/remotes; } | cksum`.
  Run it after each git status (watch batches that only touch `.git`, tree refreshes,
  the 5 s poll) while the Commits tab shows, and on switching to it; reload only when it
  differs. Single-flight like the status. `.git/index` keeps its mtime.
- **Lanes** (`Graph.add`, one commit at a time): `lanes[i]` = hash lane i waits for.
  The commit takes the lane waiting for it, else the first free one (a branch tip: no
  line from above). Every other lane waiting for it ends in its node (a curve from the
  top) and frees. Lanes waiting for something else pass straight through. The first
  parent continues the commit's lane (line node → bottom); each other parent takes the
  lane already waiting for it, or a free one with a new color (curve node → bottom).
  Trim trailing free lanes. Segments are `[fromLane, fromY, toLane, toY, color]` with
  y 0 / 1 / 2 = top / node / bottom, so a row is drawn from its own data alone. A new
  lane's color skips colors of lanes in use when it can (6 colors). Graph width = widest
  row so far.
- **Drawing:** inside the virtual list's renderer (painting is allowed there; only
  handlers are not). Per row, one `PathBuilder.stroke(1.5)` per color holding all its
  segments (`move_to` + `line_to`, or `cubic_bezier_to` with control points at the
  half-height of each end for curves), drawn with `window.paint_path(path, color)
  .absolute().top(0).left(0).size_full()` inside a `relative()` box of the cell's size;
  coordinates are local pixels. Node: filled circle (two `arc_to`s); merge: a ring (a
  filled circle with a smaller one in the row's background); HEAD: filled plus a 1.5 px
  stroked ring in the foreground color. Lanes ≥ 10 (6 in a narrow sidebar) are skipped.
  Rows: `v_virtual_list(id, n, 24, …)` + `on_item_click` + `track_scroll`; the keyboard
  uses `scroll_to_item`. Near the end, the renderer starts the next page with
  `cx.spawn` (allowed there; `cx.notify()` isn't), guarded by a flag.
- **Ref flags (GitLab style):** drawn at the node, not after the subject. A row with refs
  wraps the cell in a `relative()` h_flex with `min_w(graph width)`: the cell goes
  `absolute()` behind, a spacer of `reach(row) * lw + 1` px (`reach` = 1 + the rightmost
  lane the row draws, capped) puts the flags right after the row's own lanes, so no lane
  crosses them; flags wider than the graph push that row's subject right (text width is
  not measurable, so this is the only way to keep them clear). The cell draws a 1 px line
  from the node to the flag (`flag` option); the first flag has a 5 x 16 filled triangle
  (`PathBuilder.fill()` with `move_to`/`line_to`/`close`) pointing at the node and
  `rounded_r` on its body. Colors: the node's lane color; branch filled with `t.chrome`
  text, tag outlined with a `26` tint, remote a `4d` tint, detached `HEAD` in
  `t.foreground`, current branch bold with a foreground border. `hist.flags()` folds a
  remote branch into the local one of the same name on the same commit (`also`), drawn
  `main ⇄ origin` (`main ⇄` when narrow); the remote name comes from `git remote`
  (longest matching prefix), not from the first `/`. Every flag is drawn (no cap), each
  max 140 px (80 narrow) with ellipsis; full names stay in the commit view header pills.
  `hist.flags()` also sorts them once per commit (not per render): detached `HEAD` / the
  checked-out branch; `main`, `master`, `develop` (local, then remote-only); other local
  branches, other remote branches (natural order, case-insensitive); tags descending in
  natural order (digit runs compare as numbers, so `v1.10` before `v1.9`; git's `%D`
  gives no creation order). Overflow: the flags box is `flex_shrink_1().min_w(graph
  width).overflow_hidden()` and the subject is `flex_1().min_w(0)` (basis 0), so when
  the flags exceed the row the box shrinks first and clips them at its right edge (before
  the fixed author/date columns when they show), and the subject gets 0 px. One line,
  no wrap; rows stay 24 px.
- **Cost:** 1,000 commits loaded, 120 Hz idle baseline 8.1 ms per frame: commit list
  8.3 ms; with a 2,900-line commit view open 8.4 ms. A spike measured 300 rows with paths
  at 4–8 ms and the same rows without paths at ~4 ms.
- **Commit view:** one exec: `git show -s --format=…%B`, `\1`, then three `git show
  --format= --diff-merges=first-parent -M --no-color --no-ext-diff --no-textconv` runs:
  `--name-status -z`, `--numstat -z` and `--patch | head -c 2000000`. The three lists come
  in the same order, so pair them by index (numstat -z: a rename is `a\td\t` followed by
  two NUL-separated paths). The patch is split at `diff --git`; lines before the first
  `@@` are headers (`Binary files … differ` marks binary). Caps: 1,000 lines per file,
  3,000 per commit.
- **Diff rendering:** `language: "diff"` does **not** highlight (verified), and per-line divs
  cost 43 ms per frame at 3,000 lines. So: one readonly Editor per file (no language, no
  line numbers) at its full text height with the fence trick (clipped box, Editor laid
  out `text + max(text, 3 rows)` tall), plus one absolute tint per **run** of added,
  deleted or hunk-header lines (`ansi2` / `ansi1` with alpha `26`, `ansi4` with `1a`) and
  a 3 px bar for added/deleted runs. EditorStates are made when the commit loads, released
  when it closes, and re-made on a zoom change.
- **File as of a commit:** `git cat-file -e <sha>:<path>` then `git show <sha>:<path> |
  head -c LIMIT+1`, classified like a normal read. The path is from the repo's top (that
  is what `<rev>:<path>` means). A deleted file reads `<sha>^:<path>`. It goes through
  the normal `show()` with a `read` function and a virtual `this.file` (`<short>:<path>`):
  extension-based language and Markdown still work, git marks and stat polling skip it,
  and the popup's memory stores the tree's file (`atCommit.kept`), not the virtual one.
  Back re-reads the kept file quietly behind the commit view. A user-picked file
  (`show()` without `quiet`/`read`) closes the commit view.

### Search

- **Scope.** The document's scroll can't be set from script (only virtual lists scroll),
  so document search **marks and counts** matches and reports where the current one is
  (block or line number, line, section heading). It doesn't scroll.
- **No text highlighting.** `EditorState` exposes only `value`, `set_value`, `on` and
  `release`: no selection, range or find API. `TextView` has none either. `InputState`
  has `set_selected_range`, but that's the search field itself. Mark blocks and rows
  instead:
  - Markdown block: a 3 px `t.accent` bar at `right(-8)` in the column's right padding
    (git bars sit at `left(-8)`, so they never collide). The current block gets a 5 px bar
    and a 1 px accent frame at `inset(-4)`.
  - Non-wrapped fence and the full-height code view: rows are lines, so draw an absolute
    tint (`accent` + alpha `22`, current `44`) at `top(row × lineHeight(font))` over the
    Editor, with a bar at the right edge. Plain divs without handlers don't take the
    pointer, so selection still works.
  - Plain code layout (no repo, > 1000 lines, soft-wrapped): an 8 px strip of its own next
    to the git ruler, with proportional marks; the current one is wider, in `t.foreground`.
- **Esc and cmd-f.** Bind once in `init`:
  `cx.bind_keys([{keystroke:"escape", action, context:"FilePreviewFind"}, {keystroke:"cmd-f", action:open, context:"FilePreviewTree"}, {… "FilePreviewDoc"}])`.
  Put `.key_context("FilePreviewFind").on_action(escape, …)` on the find bar that wraps the
  `Input`, and `.key_context("FilePreviewTree"|"FilePreviewDoc").on_action(open, …)` on the
  panes. A context binding beats the app's Esc, which would close the popup.
  `window.dispatch_action(name)` reaches the same handler; the herdr `window()` import
  shadows the global, so use `globalThis.window`.
- **Typed keys bubble.** Key events from the `Input` go on up to the pane's `on_key_down`,
  so `b`, `r`, `+`, `-`, `0` and `/` would fire while you type. The find bar's own
  `on_key_down` handles `↑` `↓` (and stops propagation), and for any other key it sets a
  flag that the pane handler checks and clears. Don't stop propagation for printable keys,
  or they may never reach the field. Enter comes through `input.on("submit")`, whose event
  carries `shift`.
- **`InputState`** is created when the search opens (a handler or command, never
  `render`) and released when it closes or the root changes. `set_value` is followed by
  running the query directly (don't rely on a `change` event).
- **File list:** one `sh -c` per root, here or remote. If `git rev-parse
  --is-inside-work-tree` prints `true`, run `git --no-optional-locks -c core.fsmonitor=false
  -c core.quotepath=off ls-files --cached --others --exclude-standard -z | head -c 4000000`
  (paths come relative to the root). Otherwise run `find . -maxdepth 12 -name .git -prune -o
  \( -type f -o -type l \) -print | head -n 20000`. A first `git\0`/`find\0` field says
  which. Cache it on the context (single-flight). Mark it stale when a tree refresh
  completes; an open search re-lists at most every 5 s.
- **Fuzzy ranking:** for each path, try contiguous substrings (last anywhere, first in
  the basename), subsequences starting at each of the first 8 occurrences of the first
  letter in the basename (earliest and latest alignment of the rest), and a tightened
  subsequence. Score each one: +1 per letter, +4 when adjacent to the previous one, +3 at
  a word start (`/ - _ .`), +2 inside the basename, +4 when it starts the basename, +2 when
  it reaches the end (the extension). Subtract 0.05 × span and 0.02 × length. A query
  that extends the last one only searches the last matches. Show the top 200 in a second
  virtual list (its own scroll handle), with the name built from per-run `div`s (accent +
  bold on matched letters) and the folder dimmed and truncated.

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
- `sample.{js,sh,py,c,go,json,yaml}` (search: `samjs` → `sample.js`, `return` in `sample.py`)
- `sample.min.json`: about 5 KB on one line
- `big.md`: over 1 MB, generated by `scripts/make-big-md.sh` (not versioned)
- `tiny.png`: binary
