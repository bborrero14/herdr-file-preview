// A tree of the focused terminal's folder and a rendered preview of the chosen file:
// Markdown (prose in TextView, fences highlighted in readonly Editors, Mermaid as PNG) and code.
// It follows the focused terminal (local or remote space) and reloads what it shows when it changes.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, props, closeOverlay, openOverlay, nextCommand, home, window, run, shared, setShared } from "herdr";
import { Tree, parent, PER_FOLDER, TOTAL } from "./tree.js";
import { readSource, stamp, LIMIT } from "./source.js";
import { segment } from "./markdown.js";
import * as lang from "./lang.js";
import { Mermaid, fnv1a, cacheKey, themeOf } from "./mermaid.js";
import { dock, panelOf, size } from "./dock.js";
import { Zoom, zoomKey, ZOOM_CONTEXT, ZOOM_ESCAPE } from "./zoom.js";
import * as git from "./git.js";
import { listFiles, rank, occurrences, headings, section, FIND_CONTEXT, FIND_ESCAPE, FIND_OPEN, TREE_CONTEXT, DOC_CONTEXT } from "./find.js";

const ICON = "mods/file-preview/icons/";
const ROW = 22;              // tree row height
const FONT = 12;             // code font size at 100 %
const PROSE = 13;            // Markdown prose size at 100 %
// Editor metrics, measured at 12, 13, 14, 16 and 18 px: line height is GPUI's phi rounded, a
// mono char is 0.6 em, and soft wrap leaves WRAP_PAD px of the fence width without text.
const lineHeight = (font) => Math.round(font * 1.618034);
const charWidth = (font) => font * 0.6;
const WRAP_PAD = 24;
const CODE_PAD = 6;          // space above and below a fence's text
const COPIED_MS = 1500;
const MAX_EDITORS = 300;     // fences past this stay in the prose, uncolored
const MAX_DIAGRAM_W = 600;   // diagram display width cap (logical px), besides the column and half the PNG
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEBOUNCE = 200, MAX_WAIT = 1000;   // live reload: agents write in bursts
const POLL_FILE = 2500, POLL_TREE = 10000;
const TREE_W = 260, NARROW = 600;   // below NARROW px the tree folds into a strip
const STRIP_W = 28, NARROW_TREE_W = 220;
const TREE_KEY = "file-preview.tree.";   // + "popup" | "panel": the last explicit hide/show, persisted
// Reading zoom of the document (prose, fences, code view, diagrams); never the bars or the tree.
const LEVELS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const ZOOM_KEY = "file-preview.zoom.";   // + "popup" | "panel": the level, persisted (null at 100 %)
// Git decorations: status poll, the code view's line gutter and the long file's overview ruler.
const POLL_GIT = 5000;
// A full-height Editor lays out every row each frame: ~16 ms at 1000 rows, 45 ms at 2000.
const FULL_MAX = 1000;       // code files up to this many rows get a line gutter; longer ones, the ruler
const GUTTER = 8, RULER = 8;
const BAR_X = 8;             // a Markdown block's bar sits this far left of the column
const FILES_EVERY = 5000;    // an open file search re-lists the root at most this often

/** Reading zoom action of an unmodified key: "in" | "out" | "reset" | null. */
function textKey(e) {
  const m = e.modifiers;
  if (m.platform || m.control || m.alt) return null;
  const k = e.key, c = e.key_char;
  if (c === "+" || k === "+" || k === "=") return "in";
  if (c === "-" || k === "-") return "out";
  if (k === "0") return "reset";
  return null;
}

// Same shape as mods/files: where the focused terminal is, and on which machine.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on };
}

const ctxKey = (l) => JSON.stringify([l.cwd ?? null, l.on ?? null]);

// The first context: a launcher's props, else the focused terminal, else (focus on a mod
// pane, e.g. this panel right after its split) a terminal in the same tab.
function initial(p) {
  if (p?.cwd) return { cwd: p.cwd, on: p.on ?? null };
  const f = focused();
  if (f && !f.terminal) {
    const space = spaces().find((s) => s.active);
    const term = panes().find((x) => x.tab === f.tab && x.terminal && x.cwd);
    if (term) return { cwd: term.cwd, on: space?.machine ?? null };
  }
  return location();
}

function normalize(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return "/" + out.join("/");
}

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 5 ? "updated just now" : s < 60 ? `updated ${s}s ago` : s < 3600 ? `updated ${Math.floor(s / 60)} min ago` : `updated ${Math.floor(s / 3600)} h ago`;
}

const tilde = (p) => { const h = home(); return p && (p === h || p.startsWith(h + "/")) ? "~" + p.slice(h.length) : p ?? ""; };
const plural = (n, w) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;

/** Rows of an Editor holding `text` (a trailing newline leaves an empty last row). */
function rowCount(text) {
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** Color of a git letter: conflict red, modified yellow, added or untracked green. */
const gitColor = (g, t) => (g === "!" ? t.ansi1 : g === "M" ? t.ansi3 : t.ansi2);
const barColor = (kind, t) => (kind === "a" ? t.ansi2 : t.ansi4);
/** A theme color with an alpha byte ("#rrggbb" only), else null. */
const tint = (c, a) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c + a : null);
const matches = (n) => `${n.toLocaleString("en-US")} match${n === 1 ? "" : "es"}`;

function syntax() {
  const t = theme();
  return { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
}

export default class FilePreview extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.overlay = p.overlay ?? null;
    this.mode = p.mode ?? "popup";
    this.zoom = null;       // the expanded diagram (Zoom), if any
    this.blocks = [];       // [{ kind: "md", text } | { kind: "code", info, lines, state }]
    this.zoomFocus = cx.focus_handle();
    // Esc is the app's (it closes the popup's dialog before on_key_down sees it):
    // a binding of our own, scoped to the expanded diagram's key context, comes first.
    try { cx.bind_keys([{ keystroke: "escape", action: ZOOM_ESCAPE, context: ZOOM_CONTEXT }]); } catch {}
    // The same for a search field; cmd-f opens the search of the pane that has the keyboard.
    try {
      cx.bind_keys([{ keystroke: "escape", action: FIND_ESCAPE, context: FIND_CONTEXT },
        { keystroke: "cmd-f", action: FIND_OPEN, context: TREE_CONTEXT }, { keystroke: "cmd-f", action: FIND_OPEN, context: DOC_CONTEXT }]);
    } catch {}
    // A panel's expanded diagram: this copy is only that dialog (no tree, context or watchers).
    if (this.mode === "diagram") return this.initDiagram(p, cx);
    this.treeFocus = cx.focus_handle();
    this.previewFocus = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.findScroll = VirtualListScrollHandle.new();
    this.ts = null;         // file search of the tree: { input, query, results, total, at, ... }
    this.ds = null;         // search in the shown document: { input, query, hits, total, at, heads }
    this.inInput = false;   // the key on its way up came from a search field
    this.cursor = null;     // keyboard row (rel path)
    this.file = null;       // shown file (rel path)
    this.doc = null;        // what readSource returned, plus segments for Markdown
    this.code = null;       // EditorState of a code/text file
    this.seq = 0;           // bumps on every file load; late results are dropped
    this.stamp = null;      // "<mtime> <size>" of the shown file, when polled
    this.loadedAt = null;   // when the shown content last changed
    this.dark = settings().dark;
    this.colW = null;       // measured width of the Markdown column (for diagram sizes)
    const z = shared(ZOOM_KEY + this.mode);
    this.textZoom = LEVELS.includes(z) ? z : 1;
    this.codeFont = Math.round(FONT * this.textZoom);   // font size of every Editor
    this.width = null;      // measured width of the whole view
    // Narrow view without a stored choice: the tree is unfolded. A 45 % panel is ~550 px on a
    // 1512 px window, so it starts open unless a file comes with the props (the popup's Anchor).
    this.treeOpen = typeof p.file !== "string";
    const pref = shared(TREE_KEY + this.mode);
    this.treePref = typeof pref === "boolean" ? pref : null;   // an explicit toggle wins over the defaults
    this.resize = typeof p.resize === "number" ? { anchor: p.anchor ?? null } : null;   // a launcher's 45 %, applied once
    this.mermaid = new Mermaid();
    cx.spawn(async () => { await this.mermaid.prune(); });
    const first = initial(p);
    this.start(first, ctxKey(first), cx);
    // Dev/test aid, harmless: props { file } preselects a file (relative to the root, or absolute).
    if (typeof p.file === "string") this.reveal(p.file, cx);
    this.treeFocus.focus();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
        cx.notify();
      }
    });
    // "updated N s ago" in the status bar; nothing to redraw without a file.
    cx.timer.every(5000, (cx) => { if (this.file && this.loadedAt) cx.notify(); });
  }

  initDiagram(p, cx) {
    this.mermaid = new Mermaid();
    const d = p.diagram;
    if (d?.path && d.w > 0 && d.h > 0) this.zoom = new Zoom(d, this.mermaid, p.label ?? "Diagram");
    this.zoomFocus.focus();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (this.zoom && c.startsWith("zoom-")) this.zoomAct(c.slice(5), cx);
        cx.notify();
      }
    });
  }

  async close() {
    this.closed = true;
    if (this.zoom) this.zoom.closed = true;
    this.zoomFocus?.release();
    this.mermaid?.close();
    this.release();
    this.seq++;
    if (this.ctx) this.stop(this.ctx);
    this.ctx = null;
    this.scroll?.release();
    this.findScroll?.release();
    this.ts?.input.release();
    this.ds?.input.release();
    this.ts = this.ds = null;
    this.treeFocus?.release();
    this.previewFocus?.release();
  }

  // ---- context and tree ----------------------------------------------------

  /** Drops the tree and every watcher of the old context. `key` is the raw location key. */
  start(ctx, key, cx) {
    if (this.ctx) this.stop(this.ctx);
    this.ctxKey = key;
    const cwd = ctx.cwd || (ctx.on ? "" : home());
    this.ctx = { cwd, on: ctx.on ?? null, key, tasks: [], dirty: new Set(), all: false };
    this.tree = new Tree(cwd, this.ctx.on);
    this.git = null;        // { files, folders } of the root's repo; null outside one
    this.cursor = null;
    if (this.ts) this.closeTreeFind(null, false);
    this.show(null);
    const c = this.ctx;
    c.tasks.push(cx.timer.every(POLL_GIT, (cx) => this.gitRefresh(c, cx)));
    if (cwd) { this.refreshTree(this.ctx, null, cx, true); return; }
    // A remote space without a folder: its home, asked once.
    const tree = this.tree;
    this.loadingTree = true;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: c.on }).catch((e) => ({ code: -1, stderr: String(e.message ?? e) }));
      if (this.ctx !== c) return;
      if (r.code === 0 && r.stdout) { tree.root = c.cwd = r.stdout; this.refreshTree(c, null, cx, true); }
      else { this.loadingTree = false; tree.offline = `Cannot reach ${c.on}: ${(r.stderr || "no home folder").trim()}`; }
      cx.notify();
    });
  }

  stop(ctx) {
    for (const t of ctx.tasks) t.cancel();
    ctx.tasks = [];
    ctx.flush?.cancel();
    ctx.stopped = true;
  }

  alive(ctx) { return () => this.ctx === ctx; }

  /** Follows the focused terminal: called from render, starts at most once per new key. */
  follow(cx) {
    const f = focused();
    if (!f?.terminal) return;        // a mod pane (this one too) or no window: keep the last root
    const l = location();
    if (!l.cwd && !l.on) return;
    const key = ctxKey(l);
    if (key === this.ctxKey || this.closed) return;
    this.ctxKey = key;               // synchronously, so the next render doesn't spawn again
    cx.spawn(async (cx) => {
      if (this.ctxKey !== key || this.closed) return;
      this.retarget(l, key, cx);
      cx.notify();
    });
  }

  /** New context; the shown file stays when it is still under the new root on the same machine. */
  retarget(l, key, cx) {
    const old = this.ctx, abs = this.file && old ? this.tree.abs(this.file) : null;
    this.start(l, key, cx);
    if (!abs || (old.on ?? null) !== this.ctx.on || !this.ctx.cwd) return;
    const rel = this.tree.rel(abs);
    if (rel) this.reveal(rel, cx, { keep: true });
  }

  /** Lists the root and expanded folders (only = null), or just `only`. One run at a time per context. */
  refreshTree(ctx, only, cx, user = false) {
    if (this.ctx !== ctx || !this.tree.root) return;
    if (user) this.loadingTree = true;
    if (ctx.busy) {
      ctx.queued = ctx.queued === undefined ? only : ctx.queued === null || only === null ? null : new Set([...ctx.queued, ...only]);
      return;
    }
    ctx.busy = true;
    const tree = this.tree;
    cx.spawn(async (cx) => {
      try { await tree.reload(this.alive(ctx), only); }
      finally { ctx.busy = false; }
      if (this.ctx !== ctx) return;
      this.loadingTree = false;
      const rows = tree.rows();
      if (this.cursor === null || !rows.some((r) => r.path === this.cursor)) this.cursor = rows[0]?.path ?? null;
      // Remote: poll even when the first listing failed, so an offline machine recovers by itself.
      if ((tree.loaded || ctx.on) && !ctx.watching) this.watch(ctx, cx);
      this.gitRefresh(ctx, cx);
      this.filesChanged(ctx, cx);
      cx.notify();
      const q = ctx.queued;
      ctx.queued = undefined;
      if (q !== undefined) this.refreshTree(ctx, q, cx);
    });
  }

  reload(cx) {
    this.refreshTree(this.ctx, null, cx, true);
    if (this.file) this.show(this.file, cx);
  }

  // ---- live reload -------------------------------------------------

  watch(ctx, cx) {
    ctx.watching = true;
    if (ctx.on) return this.poll(ctx, cx);   // watchFolder is local only
    const root = this.tree.root;
    cx.spawn(async (cx) => {
      try {
        while (this.ctx === ctx) {
          const paths = await watchFolder(root);
          if (this.ctx !== ctx) return;
          this.changed(ctx, paths, cx);
        }
      } catch {
        // Linux rejects trees above 4096 directories: poll like a remote space.
        if (this.ctx === ctx) { ctx.polling = true; this.poll(ctx, cx); cx.notify(); }
      }
    });
  }

  poll(ctx, cx) {
    ctx.tasks.push(cx.timer.every(POLL_FILE, (cx) => this.statFile(ctx, cx)));
    ctx.tasks.push(cx.timer.every(POLL_TREE, (cx) => this.refreshTree(ctx, null, cx)));
  }

  /** Collects a watchFolder batch; flushes 200 ms after the last one (at most 1 s late). */
  changed(ctx, paths, cx) {
    for (const p of paths) {
      const rel = this.tree.rel(p);
      if (!rel) ctx.all = true;      // the root itself (or a path we can't place): refresh everything
      else ctx.dirty.add(rel);
    }
    const now = Date.now();
    ctx.since ??= now;
    if (ctx.flush && !ctx.flush.is_done()) {
      if (now - ctx.since >= MAX_WAIT) return;
      ctx.flush.cancel();
    }
    ctx.flush = cx.timer.after(DEBOUNCE, (cx) => this.flush(ctx, cx));
  }

  flush(ctx, cx) {
    if (this.ctx !== ctx) return;
    const { all, dirty } = ctx, tree = this.tree, file = this.file;
    ctx.all = false; ctx.dirty = new Set(); ctx.since = null;
    let reread = all;
    const folders = new Set();
    if (!all) for (const rel of dirty) {
      const up = parent(rel);
      if (tree.entries.has(up)) folders.add(up);
      if (tree.entries.has(rel)) folders.add(rel);
      if (file && (rel === file || rel === parent(file))) reread = true;   // some watchers report the folder
    }
    if (all || folders.size) this.refreshTree(ctx, all ? null : folders, cx);
    else this.gitRefresh(ctx, cx);   // e.g. only .git moved: a commit or a stage
    if (reread && file) this.show(file, cx, { quiet: true });
  }

  // ---- git decorations ----------------------------------------------------

  /** Status of the root's repo; one run at a time per context, a request meanwhile runs once after. */
  gitRefresh(ctx, cx) {
    if (this.ctx !== ctx || !this.tree.root || this.closed) return;
    if (ctx.gitBusy) { ctx.gitAgain = true; return; }
    ctx.gitBusy = true;
    const root = this.tree.root;
    cx.spawn(async (cx) => {
      let s;
      try { s = await git.status(root, ctx.on); }
      finally { ctx.gitBusy = false; }
      if (this.ctx !== ctx) return;
      if (s !== undefined && !git.same(this.git, s)) {
        const file = this.file, before = file ? this.git?.files.get(file) : undefined;
        this.git = s;
        if (file && s?.files.get(file) !== before) this.refreshMarks(cx);
        cx.notify();
      }
      if (ctx.gitAgain) { ctx.gitAgain = false; this.gitRefresh(ctx, cx); }
    });
  }

  /** Changed lines of the shown file: none when clean or outside a repo, all for an untracked one. */
  refreshMarks(cx) {
    const file = this.file, doc = this.doc, ctx = this.ctx;
    const letter = file && this.git ? this.git.files.get(file) : undefined;
    if (!doc || (doc.kind !== "markdown" && doc.kind !== "text") || !letter) return this.setMarks(null);
    if (letter === "U") return this.setMarks(git.added(doc.text));
    if (this.marking) { this.markAgain = true; return; }
    this.marking = true;
    const root = this.tree.root;
    cx.spawn(async (cx) => {
      let m;
      try { m = await git.changes(root, file, doc.text, ctx.on); }
      finally { this.marking = false; }
      if (this.ctx === ctx && this.file === file && this.doc === doc && m !== undefined) { this.setMarks(m); cx.notify(); }
      if (this.markAgain) { this.markAgain = false; this.refreshMarks(cx); }
    });
  }

  setMarks(m) {
    this.marks = m;
    this.decorate();
  }

  /**
   * Puts the marks on what shows them: each Markdown block gets a bar kind and deletion
   * markers (top / bottom); the code view gets runs of changed lines.
   */
  decorate() {
    const m = this.marks;
    this.codeMarks = m && this.doc?.kind === "text" ? { runs: git.runs(m), dels: [...m.dels].sort((a, b) => a - b) } : null;
    const blocks = this.blocks.filter((b) => b.start);
    for (const b of blocks) b.mark = m ? { bar: git.rangeKind(m, b.start, b.end), top: false, bottom: false } : null;
    if (!m || !blocks.length) return;
    for (const n of m.dels) {
      // After line n: the first block that ends at or below it, else the last one's bottom.
      const b = blocks.find((b) => b.end >= n);
      if (!b) blocks[blocks.length - 1].mark.bottom = true;
      else if (n === b.end && n >= b.start) b.mark.bottom = true;
      else b.mark.top = true;
    }
  }

  /** Remote (or polled) file: re-read only when its mtime or size moves. */
  async statFile(ctx, cx) {
    const rel = this.file;
    if (this.ctx !== ctx || !rel || ctx.statting) return;
    ctx.statting = true;
    let s;
    try { s = await stamp(this.tree.abs(rel), ctx.on); }
    catch { s = null; }              // unreachable: try again on the next tick
    finally { ctx.statting = false; }
    if (this.ctx !== ctx || this.file !== rel || s === null) return;
    const before = this.stamp;
    this.stamp = s;
    if (before === null ? s === "missing" && this.doc && this.doc.kind !== "missing" : s !== before) this.show(rel, cx, { quiet: true });
  }

  expand(rel, cx) {
    const tree = this.tree, ctx = this.ctx;
    tree.expanded.add(rel);
    if (!tree.entries.has(rel) && !tree.pending.has(rel))
      cx.spawn(async (cx) => {
        try { await tree.load(rel, this.alive(ctx)); }
        catch (e) { if (this.ctx === ctx) { tree.expanded.delete(rel); if (e.unreachable) tree.offline = e.message; else this.note = String(e.message ?? e); } }
        cx.notify();
      });
    cx.notify();
  }

  toggle(rel, cx) {
    if (this.tree.expanded.has(rel)) { this.tree.collapse(rel); cx.notify(); }
    else this.expand(rel, cx);
  }

  /** Opens a file by path (relative to the root, or absolute inside it), expanding its folders. */
  reveal(path, cx, opts = {}) {
    const root = this.tree.root;
    let rel = path.startsWith("/") ? this.tree.rel(path) : path.replace(/^\.\//, "");
    if (!rel) { this.note = `Outside ${tilde(root)}: ${path}`; cx.notify(); return; }
    const ctx = this.ctx, tree = this.tree;
    cx.spawn(async (cx) => {
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        tree.expanded.add(folder);
        if (!tree.entries.has(folder)) await tree.load(folder, this.alive(ctx)).catch(() => {});
        if (this.ctx !== ctx) return;
      }
      this.cursor = rel;
      const i = tree.rows().findIndex((r) => r.path === rel);
      if (i >= 0) this.scroll.scroll_to_item(i, "center");
      if (!opts.treeOnly) this.show(rel, cx, opts);
      cx.notify();
    });
  }

  // ---- file loading ----------------------------------------------------------

  release() {
    for (const b of this.blocks) b.state?.release();
    this.blocks = [];
    this.code?.release();
    this.code = null;
  }

  /**
   * Shows a file. quiet: a live reload (no spinner; nothing is rebuilt when the content is the
   * same). keep: after a context change, clear the preview if the file isn't there.
   */
  show(rel, cx, { quiet = false, keep = false } = {}) {
    const seq = ++this.seq;
    if (rel !== this.file) { this.release(); this.doc = null; this.stamp = null; this.loadedAt = null; this.marks = null; this.codeMarks = null; if (this.ds) this.closeDocFind(false); }
    this.file = rel;
    if (!quiet) { this.note = null; this.loadingFile = Boolean(rel); }
    if (!rel || !cx) { this.loadingFile = false; return; }
    const ctx = this.ctx, abs = this.tree.abs(rel);
    cx.spawn(async (cx) => {
      let doc;
      try { doc = await readSource(abs, ctx.on); }
      catch (e) { doc = { kind: "error", message: String(e.message ?? e) }; }
      if (this.seq !== seq || this.ctx !== ctx) return;
      this.loadingFile = false;
      if (keep && doc.kind === "missing") { this.show(null); cx.notify(); return; }
      if (doc.kind === "text") doc.lines = rowCount(doc.text);
      const prev = this.doc;
      if (prev && prev.kind === doc.kind && prev.text === doc.text && prev.message === doc.message && prev.truncated === doc.truncated) { cx.notify(); return; }
      if (doc.kind === "markdown") {
        doc.segments = segment(doc.text);
        // Cached PNGs become known before the first paint: no placeholder, no layout jump.
        const theme = themeOf(this.dark);
        await this.mermaid.prepare(doc.segments.filter((s) => s.kind !== "md" && s.info.toLowerCase() === "mermaid").map((s) => cacheKey(s.text, theme)));
        if (this.seq !== seq || this.ctx !== ctx) return;
      }
      this.doc = doc;
      this.loadedAt = Date.now();
      if (!this.patch(prev, cx)) this.build(cx);
      this.decorate();
      this.runDoc();
      this.refreshMarks(cx);
      cx.notify();
    });
  }

  /** What build() makes of this.doc's segments, without EditorStates. */
  plan(segments) {
    const out = [], seen = new Map();
    let editors = 0;
    for (const s of segments) {
      if (s.kind === "md") { out.push(s); continue; }
      const mermaid = s.info.toLowerCase() === "mermaid", start = s.start, end = s.end;
      if (editors >= MAX_EDITORS) { out.push({ kind: "md", text: "```" + s.info + "\n" + s.text + "\n```", start, end }); continue; }
      editors++;
      const lines = Math.max(1, s.text.split("\n").length);
      // A wrapped fence's height follows the column width (rows()).
      if (!mermaid) { out.push({ kind: "code", info: s.info, text: s.text, lines, start, end, wrap: lang.wraps(lang.forFence(s.info)) }); continue; }
      // Diagrams are compared by source: unchanged ones keep their render across a reload.
      const hash = fnv1a(s.text), n = (seen.get(hash) ?? 0) + 1;
      seen.set(hash, n);
      out.push({ kind: "mmd", info: s.info, text: s.text, lines, start, end, hash, id: n === 1 ? `mmd-${hash}` : `mmd-${hash}-${n}` });
    }
    return out;
  }

  /**
   * Live reload in place: same block layout → swap texts and set_value the EditorStates, so the
   * element ids (doc:<rel>, md-<i>, code-<i>) and the Editors survive. False → build() instead.
   */
  patch(prev, cx) {
    const doc = this.doc;
    if (!prev || prev.kind !== doc.kind) return false;
    if (doc.kind === "text") { if (!this.code) return false; this.code.set_value(doc.text); return true; }
    if (doc.kind !== "markdown") return false;
    const next = this.plan(doc.segments);
    if (next.length !== this.blocks.length || next.some((b, i) => b.kind !== this.blocks[i].kind || (b.kind === "code" && b.info !== this.blocks[i].info))) return false;
    next.forEach((b, i) => {
      const old = this.blocks[i];
      if (b.kind === "md") { this.blocks[i] = b; return; }
      if (b.kind === "mmd") {
        if (old.hash === b.hash) { old.id = b.id; old.start = b.start; old.end = b.end; return; }   // same diagram: keep its render
        old.state?.release();
        this.blocks[i] = b;
        return;
      }
      if (old.text !== b.text) old.state.set_value(b.text);
      old.text = b.text; old.lines = b.lines; old.vis = null; old.start = b.start; old.end = b.end;
    });
    this.diagrams(cx);
    return true;
  }

  /** (Re)creates the EditorStates for this.doc. Never called from render itself. */
  build(cx) {
    this.release();
    const doc = this.doc;
    if (!doc) return;
    const base = { readonly: true, font_family: settings().font_family, font_size: this.codeFont, syntax: syntax() };
    if (doc.kind === "text") {
      const language = lang.forPath(this.file);
      this.code = EditorState.new({ ...base, ...(language ? { language } : {}), soft_wrap: lang.wraps(language), value: doc.text });
      return;
    }
    if (doc.kind !== "markdown") return;
    for (const b of this.plan(doc.segments)) {
      if (b.kind === "md" || b.kind === "mmd") { this.blocks.push(b); continue; }
      this.blocks.push({ ...b, state: this.fenceState(b.text, lang.forFence(b.info)) });
    }
    this.diagrams(cx);
  }

  fenceState(value, language) {
    return EditorState.new({ readonly: true, font_family: settings().font_family, font_size: this.codeFont, syntax: syntax(),
      ...(language ? { language } : {}), value, line_numbers: false, folding: false, soft_wrap: lang.wraps(language) });
  }

  /** Steps the reading zoom ("in" | "out" | "reset") and keeps it for this mode's next copies. */
  textAct(a, cx) {
    const i = LEVELS.indexOf(this.textZoom);
    const z = a === "reset" ? 1 : LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i + (a === "in" ? 1 : -1)))];
    if (z === this.textZoom) return;
    this.textZoom = z;
    setShared(ZOOM_KEY + this.mode, z === 1 ? null : z);
    const font = Math.round(FONT * z);
    if (font !== this.codeFont) { this.codeFont = font; this.refont(); }
    cx.notify();
  }

  /** EditorStates take their font size only at creation: new ones in place, blocks and diagrams kept. */
  refont() {
    if (this.code) {
      const language = lang.forPath(this.file);
      this.code.release();
      this.code = EditorState.new({ readonly: true, font_family: settings().font_family, font_size: this.codeFont, syntax: syntax(),
        ...(language ? { language } : {}), soft_wrap: lang.wraps(language), value: this.doc?.text ?? "" });
    }
    for (const b of this.blocks) {
      if (!b.state) continue;
      b.state.release();
      b.state = this.fenceState(b.text, b.kind === "mmd" ? null : lang.forFence(b.info));
      b.vis = null;
    }
  }

  /** Prose size of the reading zoom. */
  proseSize() { return Math.round(PROSE * this.textZoom); }

  /** Visual rows of a fence; a soft-wrapped one depends on the measured column width. */
  rows(b) {
    if (!b.wrap || !this.colW) return b.lines;
    const cols = Math.max(1, Math.floor((this.colW - WRAP_PAD) / charWidth(this.codeFont)));
    if (b.vis?.cols !== cols) b.vis = { cols, n: lang.wrappedRows(b.text, cols) };   // per width, not per frame
    return b.vis.n;
  }

  // ---- Mermaid ---------------------------------------------------------

  /** Asks for every diagram block without a result: cached PNGs answer at once, the rest queue. */
  diagrams(cx) {
    if (!cx || this.closed) return;
    const theme = themeOf(this.dark);
    for (const b of this.blocks) {
      if (b.kind !== "mmd" || b.d) continue;
      const key = cacheKey(b.text, theme), ctx = this.ctx, file = this.file;
      b.key = key;
      b.d = { pending: true };
      const alive = () => !this.closed && this.ctx === ctx && this.file === file && b.key === key && this.blocks.includes(b);
      this.mermaid.request({ key, source: b.text, theme }, {
        alive,
        done: (res, cx) => {
          if (!alive()) return;
          b.d = res;
          // Fallback: the source as a plain code block (EditorState made here, never in render).
          if (res.error && !b.state) b.state = this.fenceState(b.text, null);
          cx.notify();
        },
      }, cx);
    }
  }

  /** A notice's Retry: a setup error retries the lookup and every setup notice; a render error, this diagram. */
  retryDiagram(b, cx) {
    if (b.d?.setup) {
      this.mermaid.retrySetup();
      for (const o of this.blocks) if (o.kind === "mmd" && o.d?.setup) o.d = null;
    } else if (b.d?.error) {
      for (const o of this.blocks) if (o.kind === "mmd" && o.key === b.key) o.d = null;   // twins share the render
      this.mermaid.forget(b.key);
    }
    this.diagrams(cx);
    cx.notify();
  }

  /** Displayed size of a w × h PNG (rendered at -s 2): the same formula for the image and its placeholder. */
  diagramSize(w, h) {
    const z = this.textZoom, dw = Math.max(1, Math.min(this.colW ?? 812, (w / 2) * z, MAX_DIAGRAM_W * z));
    return { w: dw, h: (dw * h) / w };
  }

  /** Diagram n (document order, from 0) expanded: a layer in the popup, a dialog over the window from the panel. */
  expandDiagram(n, cx) {
    const list = this.blocks.filter((b) => b.kind === "mmd"), b = list[n];
    if (!b?.d?.ok) { this.note = b ? `Diagram ${n + 1} is not rendered` : `No diagram ${n + 1}`; cx.notify(); return; }
    const d = { key: b.key, source: b.text, theme: themeOf(this.dark), path: b.d.path, w: b.d.w, h: b.d.h };
    const label = `${this.file} · diagram ${n + 1} of ${list.length}`;
    // A window overlay would draw under this popup's dialog, so the popup draws its own layer.
    if (this.mode === "panel") openOverlay({ kind: "dialog", width: 0.95, height: 0.95, mod: "file-preview", props: { mode: "diagram", diagram: d, label } });
    else { this.zoom = new Zoom(d, this.mermaid, label); this.zoomFocus.focus(); }
    cx.notify();
  }

  /** "in" | "out" | "fit" | "close" on the expanded diagram. */
  zoomAct(a, cx) {
    if (!this.zoom) return;
    if (a !== "close") return this.zoom.act(a, cx);
    if (this.mode === "diagram") { if (this.overlay) closeOverlay(this.overlay); return; }
    this.zoom.closed = true;
    this.zoom = null;
    this.previewFocus.focus();
  }

  zoomKeyDown(e, cx) {
    const a = zoomKey(e);
    if (!a) return;
    cx.stop_propagation();
    this.zoomAct(a, cx);
    cx.notify();
  }

  // ---- search ----------------------------------------------------------------

  /** The tree's file search: a field over the tree; a non-empty query lists matching paths. */
  openTreeFind(cx) {
    if (!this.tree.root) return;
    this.focusTree(true);
    if (!this.ts) {
      const input = InputState.new({ placeholder: "Find a file…" });
      const ts = this.ts = { input, query: "", results: [], total: 0, at: 0, pool: null, poolQ: null, poolData: null, opened: null };
      input.on("change", (_e, cx) => { if (this.ts === ts && input.value() !== ts.query) this.treeQuery(input.value(), cx); });
      input.on("submit", (_e, cx) => { if (this.ts === ts) { this.treePick(cx); cx.notify(); } });
    }
    this.ts.input.focus();
    this.loadFiles(this.ctx, cx);
    cx?.notify();
  }

  /** Esc or ✕: back to the tree, on the file opened from the results. */
  closeTreeFind(cx, reveal = true) {
    const ts = this.ts;
    if (!ts) return;
    this.ts = null;
    ts.input.release();
    if (!cx) return;
    this.treeFocus.focus();
    if (reveal && ts.opened && ts.opened === this.file) this.reveal(ts.opened, cx, { treeOnly: true });
    cx.notify();
  }

  /** Lists the root's files once per context (again when stale); one run at a time. */
  loadFiles(ctx, cx) {
    if (!ctx || this.ctx !== ctx || !this.tree.root || !cx) return;
    const f = ctx.files ??= { data: null, loading: false, stale: true, error: null, at: 0 };
    if (f.loading || !f.stale) return;
    f.loading = true; f.stale = false; f.at = Date.now();
    const root = this.tree.root;
    cx.spawn(async (cx) => {
      try { f.data = await listFiles(root, ctx.on); f.error = null; }
      catch (e) { f.error = String(e.message ?? e); }
      finally { f.loading = false; }
      if (this.ctx !== ctx) return;
      if (this.ts) {
        if (f.stale) this.loadFiles(ctx, cx);   // changed meanwhile
        this.treeQuery(this.ts.query, cx, true);
      }
      cx.notify();
    });
  }

  /** The tree changed: the next search re-lists; an open one now, at most every FILES_EVERY ms. */
  filesChanged(ctx, cx) {
    const f = ctx.files;
    if (!f) return;
    f.stale = true;
    if (this.ts && !f.loading && Date.now() - f.at >= FILES_EVERY) this.loadFiles(ctx, cx);
  }

  treeQuery(q, cx, fresh = false) {
    const ts = this.ts;
    if (!ts) return;
    const keep = ts.results[ts.at]?.path;
    ts.query = q;
    const f = this.ctx?.files, data = f?.data, norm = q.toLowerCase().replace(/\s+/g, "");
    if (f?.stale && Date.now() - f.at >= FILES_EVERY) this.loadFiles(this.ctx, cx);
    if (!data || !norm) { ts.results = []; ts.total = 0; ts.pool = null; ts.poolQ = null; ts.at = 0; cx.notify(); return; }
    // A longer query only narrows the last one's matches.
    const pool = !fresh && ts.pool && ts.poolData === data && ts.poolQ && norm.startsWith(ts.poolQ) ? ts.pool : null;
    const r = rank(data, q, pool);
    ts.results = r.results; ts.total = r.total; ts.pool = r.pool; ts.poolQ = norm; ts.poolData = data;
    // A re-list keeps the selected row; typing starts at the top.
    const i = fresh && keep ? ts.results.findIndex((x) => x.path === keep) : -1;
    ts.at = Math.max(0, i);
    this.findScroll.scroll_to_item(ts.at);
    cx.notify();
  }

  treeMove(d) {
    const ts = this.ts;
    if (!ts?.results.length) return;
    ts.at = Math.max(0, Math.min(ts.results.length - 1, ts.at + d));
    this.findScroll.scroll_to_item(ts.at);
  }

  /** Enter on a result: opens it; the field keeps the keyboard. */
  treePick(cx) {
    const r = this.ts?.results[this.ts.at];
    if (!r) return;
    this.ts.opened = r.path;
    this.cursor = r.path;
    this.show(r.path, cx);
  }

  findClick(path, cx) {
    const ts = this.ts;
    if (!ts) return;
    const i = ts.results.findIndex((r) => r.path === path);
    if (i < 0) return;
    ts.at = i;
    this.treePick(cx);
    ts.input.focus();
    cx.notify();
  }

  /** Search in the shown document: marks the blocks (or lines) with matches; it can't scroll to them. */
  openDocFind(cx) {
    const doc = this.doc;
    if (!this.file || !doc || (doc.kind !== "markdown" && doc.kind !== "text")) { this.note = "Nothing to search"; cx?.notify(); return; }
    if (!this.ds) {
      const input = InputState.new({ placeholder: "Find in document…" });
      const ds = this.ds = { input, query: "", hits: [], total: 0, at: 0, heads: [] };
      input.on("change", (_e, cx) => { if (this.ds === ds && input.value() !== ds.query) this.docQuery(input.value(), cx); });
      input.on("submit", (e, cx) => { if (this.ds === ds) { this.docStep(e?.shift ? -1 : 1); cx.notify(); } });
    }
    this.ds.input.focus();
    cx?.notify();
  }

  closeDocFind(focus = true) {
    const ds = this.ds;
    if (!ds) return;
    this.ds = null;
    for (const b of this.blocks) b.find = null;
    ds.input.release();
    if (focus) this.previewFocus.focus();
  }

  docQuery(q, cx) {
    const ds = this.ds;
    if (!ds) return;
    ds.query = q;
    ds.at = 0;
    this.runDoc();
    cx.notify();
  }

  /**
   * Matches of the query in the document's source (case-insensitive): per line in a code file,
   * per block in Markdown. Run again after every load, so a live reload keeps the search.
   */
  runDoc() {
    for (const b of this.blocks) b.find = null;
    const ds = this.ds, doc = this.doc;
    if (!ds) return;
    ds.hits = []; ds.total = 0;
    const q = ds.query.toLowerCase();
    if (!q || !doc) return;
    if (doc.kind === "text") {
      const o = occurrences(doc.text, q);
      ds.hits = o.lines.map((l) => ({ line: l.line + 1, n: l.n }));
      ds.total = o.total;
    } else if (doc.kind === "markdown") {
      ds.heads = headings(this.blocks);
      for (const b of this.blocks) {
        const o = occurrences(b.text, q);
        if (!o.total) continue;
        // A fence's text starts under its opening line; a prose chunk at its first line.
        const first = b.kind === "md" ? b.start : b.start + 1;
        b.find = { n: o.total, rows: o.lines.map((l) => l.line), current: false };
        ds.hits.push({ block: b, line: first + o.lines[0].line, n: o.total });
        ds.total += o.total;
      }
    }
    ds.at = Math.max(0, Math.min(ds.hits.length - 1, ds.at));
    const cur = ds.hits[ds.at]?.block;
    if (cur) cur.find.current = true;
  }

  /** Next (1) or previous (-1) block or line with matches, wrapping around. */
  docStep(d) {
    const ds = this.ds, n = ds?.hits.length;
    if (!n) return;
    const old = ds.hits[ds.at]?.block;
    if (old) old.find.current = false;
    ds.at = (ds.at + d + n) % n;
    const cur = ds.hits[ds.at].block;
    if (cur) cur.find.current = true;
  }

  /** "block 3 of 7 · line 120 · Heading": where the current match is, since the view can't go there. */
  docWhere() {
    const ds = this.ds, h = ds?.hits[ds.at];
    if (!h) return null;
    const what = this.doc?.kind === "text" ? "line" : "block";
    const sec = what === "block" ? section(ds.heads, h.line) : null;
    return `${what} ${ds.at + 1} of ${ds.hits.length} · line ${h.line}` + (sec ? ` · ${sec.text}` : "");
  }

  /** "tree" | "doc" for a command without a side: the open search, else the pane with the keyboard. */
  findSide() {
    if (this.previewFocus.is_focused()) return "doc";
    if (this.treeFocus.is_focused()) return "tree";
    return this.ds && !this.ts ? "doc" : "tree";
  }

  /** Dev hook: opens a search with a query, as if typed. */
  findCmd(side, q, cx) {
    if (side === "tree") {
      this.openTreeFind(cx);
      if (!this.ts) return;
      this.ts.input.set_value(q);
      this.treeQuery(q, cx);
    } else {
      this.openDocFind(cx);
      if (!this.ds) return;
      this.ds.input.set_value(q);
      this.docQuery(q, cx);
    }
  }

  /** Keys typed into a search field: arrows act here, the rest stays in the field. */
  findKey(e, cx, side) {
    const m = e.modifiers;
    if (!m.platform && !m.control && !m.alt) {
      if (side === "tree") {
        const d = { down: 1, up: -1, pagedown: 10, pageup: -10 }[e.key];
        if (d) { cx.stop_propagation(); this.treeMove(d); cx.notify(); return; }
      } else if (e.key === "down" || e.key === "up") {
        cx.stop_propagation(); this.docStep(e.key === "down" ? 1 : -1); cx.notify(); return;
      }
    }
    this.inInput = true;   // the pane's on_key_down, next on the way up, leaves it alone
  }

  // ---- keyboard --------------------------------------------------------------

  command(c, cx) {
    if (c === "focus") return this.focusTree();
    if (c === "anchor") return this.anchor();
    // Key names as commands (`file-preview.down`), so the tree can be driven without a keyboard.
    if (c === "reload") return this.reload(cx);
    if (c.startsWith("open:")) return this.reveal(c.slice(5), cx);
    // Same as each diagram notice's Retry.
    if (c === "retry-diagrams") { const b = this.blocks.find((b) => b.d?.setup) ?? this.blocks.find((b) => b.d?.error); if (b) this.retryDiagram(b, cx); return; }
    // Expanded diagram: expand:<n>, then zoom-in, zoom-out, zoom-fit, zoom-close (the + − 0 Esc keys).
    if (c.startsWith("expand:")) { const n = Number(c.slice(7)); if (Number.isInteger(n) && n >= 0) this.expandDiagram(n, cx); return; }
    if (c.startsWith("zoom-")) return this.zoomAct(c.slice(5), cx);
    // Reading zoom: text-in, text-out, text-reset (the + − 0 keys outside an expanded diagram).
    if (c === "text-in" || c === "text-out" || c === "text-reset") return this.textAct(c.slice(5), cx);
    // copy:<n>: code box n (document order, from 0), like its Copy button.
    if (c.startsWith("copy:")) {
      const n = Number(c.slice(5)), b = Number.isInteger(n) ? this.codeBoxes()[n] : null;
      if (b) this.copyBlock(b, cx); else { this.note = `No code block ${c.slice(5)}`; cx.notify(); }
      return;
    }
    // Forgets the stored tree choice of this mode (back to the defaults).
    if (c === "tree-reset") { this.treePref = null; setShared(TREE_KEY + this.mode, null); return; }
    // Search: tree-find:<q>, doc-find:<q>, find:<q> (the pane with the keyboard), find-next,
    // find-prev, find-enter (open the selected result), find-close, find-esc (the Esc action).
    if (c.startsWith("tree-find:")) return this.findCmd("tree", c.slice(10), cx);
    if (c.startsWith("doc-find:")) return this.findCmd("doc", c.slice(9), cx);
    if (c.startsWith("find:")) return this.findCmd(this.findSide(), c.slice(5), cx);
    if (c === "find-next" || c === "find-prev") { const d = c === "find-next" ? 1 : -1; if (this.ds) this.docStep(d); else this.treeMove(d); return; }
    if (c === "find-enter") { if (this.ts) this.treePick(cx); else this.docStep(1); return; }
    if (c === "find-close") { if (this.ds && this.findSide() === "doc") this.closeDocFind(); else if (this.ts) this.closeTreeFind(cx); else this.closeDocFind(); return; }
    if (c === "find-esc") {
      // Down the focus path, like the bound Esc: only a focused search field answers it.
      try { globalThis.window.dispatch_action(FIND_ESCAPE); } catch (e) { this.note = `find-esc: ${String(e.message ?? e)}`; }
      return;
    }
    this.treeKey(c, cx);
  }

  rowsNow() { return this.tree.rows(); }

  moveTo(rows, i) {
    if (!rows.length) return;
    i = Math.max(0, Math.min(rows.length - 1, i));
    this.cursor = rows[i].path;
    this.scroll.scroll_to_item(i);
  }

  /** Returns true when the key was used. */
  treeKey(k, cx) {
    const rows = this.rowsNow(), i = rows.findIndex((r) => r.path === this.cursor), row = rows[i];
    if (k === "down") this.moveTo(rows, i + 1);
    else if (k === "up") this.moveTo(rows, i < 0 ? 0 : i - 1);
    else if (k === "pagedown") this.moveTo(rows, i + 20);
    else if (k === "pageup") this.moveTo(rows, i - 20);
    else if (k === "home") this.moveTo(rows, 0);
    else if (k === "end") this.moveTo(rows, rows.length - 1);
    else if (k === "right") {
      if (!row?.dir || row.denied) return false;
      if (!this.tree.expanded.has(row.path)) this.expand(row.path, cx);
      else if (rows[i + 1]?.depth > row.depth) this.moveTo(rows, i + 1);
    } else if (k === "left") {
      if (!row) return false;
      if (row.dir && this.tree.expanded.has(row.path)) this.tree.collapse(row.path);
      else if (row.depth > 0) this.moveTo(rows, rows.findIndex((r) => r.path === parent(row.path)));
    } else if (k === "enter" || k === "space") {
      if (!row || row.denied) return false;
      if (row.dir) this.toggle(row.path, cx); else this.show(row.path, cx);
    } else if (k === "tab") this.previewFocus.focus();
    else if (k === "r") this.reload(cx);
    else if (k === "b") this.toggleTree();
    else return false;
    cx.notify();
    return true;
  }

  onKey(e, cx, where) {
    if (this.inInput) { this.inInput = false; return; }   // typed into a search field
    const m = e.modifiers;
    if (m.platform && !m.control && !m.alt && e.key === "f") { cx.stop_propagation(); this.openFind(where, cx); return; }
    if (m.platform || m.control || m.alt) return;
    if (e.key === "escape") { if (this.overlay) closeOverlay(this.overlay); return; }
    if (e.key === "/" || e.key_char === "/") { cx.stop_propagation(); this.openFind(where, cx); return; }
    // n / shift-n: next and previous match block while the document has the keyboard.
    if (where === "preview" && this.ds && (e.key === "n" || e.key === "N")) {
      cx.stop_propagation(); this.docStep(m.shift || e.key === "N" ? -1 : 1); cx.notify(); return;
    }
    const a = textKey(e);
    if (a) { cx.stop_propagation(); this.textAct(a, cx); return; }
    let used;
    if (where === "tree") used = this.treeKey(e.key, cx);
    else if (e.key === "tab") { this.focusTree(true); used = true; }
    else if (e.key === "r") { this.reload(cx); used = true; }
    else if (e.key === "b") { this.toggleTree(); used = true; }
    if (used) { cx.stop_propagation(); cx.notify(); }
  }

  openFind(where, cx) {
    if (where === "tree") this.openTreeFind(cx); else this.openDocFind(cx);
  }

  // ---- panel ----------------------------------------------------------

  narrow() { return this.width !== null && this.width < NARROW; }
  /** The stored choice of this mode, else: shown when wide; when narrow, as the panel started. */
  treeShown() { return this.treePref ?? (!this.narrow() || this.treeOpen); }

  /** Tree focus; with the tree hidden, the preview (open: show it first). */
  focusTree(open = false) {
    if (!this.treeShown() && open) this.setTree(true);
    (this.treeShown() ? this.treeFocus : this.previewFocus).focus();
  }

  toggleTree() {
    this.setTree(!this.treeShown());
    (this.treeShown() ? this.treeFocus : this.previewFocus).focus();
  }

  /** An explicit hide/show: kept for the next popup or panel (per mode), at any width. */
  setTree(open) {
    this.treePref = this.treeOpen = open;
    setShared(TREE_KEY + this.mode, open);
  }

  sized(box, cx) {
    if (this.resize !== null) {
      // Focus moves to a freshly split pane, so it's this one; else this tab's panel.
      const f = focused(), mine = panes().find((p) => p.mod === "file-preview" && p.focused) ?? (f && panelOf(f.tab));
      if (mine) size(mine.pane, this.resize.anchor);
      this.resize = null;
    }
    const w = Math.round(box.width);
    if (w === this.width) return;
    const was = this.treeShown();
    this.width = w;
    if (was && !this.treeShown() && this.treeFocus.is_focused()) this.previewFocus.focus();   // its element goes
    cx.notify();
  }

  /** Popup ⇥: the same panel as the launcher, on this root and file; then the popup goes. */
  anchor() {
    if (!this.overlay) return;
    const f = focused(), open = f && panelOf(f.tab);
    if (open) run("pane.close", { pane: open.pane });   // one panel per tab: the new one replaces it
    dock({ cwd: this.tree.root || this.ctx?.cwd || null, on: this.ctx?.on ?? null, ...(this.file ? { file: this.tree.abs(this.file) } : {}) });
    closeOverlay(this.overlay);
  }

  /** ✕: the popup closes its overlay; the panel, its pane. */
  closeView() {
    if (this.overlay) return closeOverlay(this.overlay);
    const mine = panelOf(focused()?.tab);
    if (mine) run("pane.close", { pane: mine.pane });
  }

  click(key, cx) {
    const row = this.rowsNow().find((r) => r.path === key);
    this.treeFocus.focus();
    if (!row) return;
    this.cursor = row.path;
    if (row.denied) { cx.notify(); return; }
    if (row.dir) this.toggle(row.path, cx); else this.show(row.path, cx);
    cx.notify();
  }

  link(url, cx) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url)) {
      if (/^(https?|mailto):/i.test(url) && !this.ctx.on) exec(window()?.platform === "linux" ? "xdg-open" : "open", [url]).catch(() => {});
      return;
    }
    let path = url.replace(/^file:\/\//i, "").split("#")[0];
    try { path = decodeURI(path); } catch {}
    if (!path) return;
    const abs = path.startsWith("/") ? normalize(path) : normalize(this.tree.abs(parent(this.file ?? "")) + "/" + path);
    this.reveal(abs, cx);
  }

  // ---- UI ----------------------------------------------------------------------

  render(cx) {
    const t = theme();
    if (this.mode === "diagram") {
      if (!this.zoom) return v_flex().size_full().bg(t.surface).child(this.message(t, "Nothing to show", "Esc close"));
      return this.zoomLayer(t);
    }
    this.follow(cx);
    if (settings().dark !== this.dark) {
      // Theme flipped: syntax colors are baked into the EditorStates, so rebuild them (outside render).
      this.dark = settings().dark;
      cx.spawn(async (cx) => { this.build(cx); this.decorate(); this.runDoc(); cx.notify(); });
    }
    const rows = this.tree.rows(), narrow = this.narrow(), shown = this.treeShown();
    // The expanded diagram replaces the popup's content: nothing under it can take the pointer
    // (no occlusion API), and the EditorStates stay retained for the way back.
    if (this.zoom) return v_flex().id("fp-root").size_full().min_h(0).on_size_change((box, cx) => this.sized(box, cx)).child(this.zoomLayer(t));
    return v_flex().id("fp-root").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(13)
      .on_size_change((box, cx) => this.sized(box, cx))
      .child(this.topBar(t))
      .child(h_flex().flex_1().min_h(0)
        .when(narrow || !shown, (el) => el.child(this.strip(t)))
        .when(shown, (el) => el.child(this.treePane(rows, t, narrow ? Math.min(NARROW_TREE_W, Math.round(this.width * 0.55)) : TREE_W)))
        .child(this.previewPane(t, narrow)))
      .child(this.statusBar(t));
  }

  zoomLayer(t) {
    return this.zoom.render(t, this.zoomFocus, {
      button: (id, icon, t, onClick) => this.button(id, icon, t, onClick),
      onKey: (e, cx) => this.zoomKeyDown(e, cx),
      onEscape: (cx) => { this.zoomAct("close", cx); cx?.notify(); },
      onClose: (cx) => { this.zoomAct("close", cx); cx.notify(); },
    });
  }

  button(id, icon, t, onClick) {
    return h_flex().id(id).size(22).flex_none().rounded(5).items_center().justify_center().cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(onClick).child(svg(ICON + icon).size(14).text_color(t.muted));
  }

  textButton(id, label, t, onClick) {
    return h_flex().id(id).h(22).px(5).flex_none().rounded(5).items_center().justify_center().cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(onClick).text_size(12).text_color(t.muted).child(label);
  }

  topBar(t) {
    const on = this.ctx?.on;
    return h_flex().h(28).flex_none().pl(4).pr(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(this.button("fp-tree-bar", "sidebar.svg", t, (_e, cx) => { this.toggleTree(); cx.notify(); }))
      .child(this.button("fp-find-tree", "search.svg", t, (_e, cx) => this.openTreeFind(cx)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(tilde(this.tree.root) || "No folder"))
      .when(Boolean(on), (el) => el.child(div().flex_none().px(6).rounded(4).bg(t.raised).text_size(11)
        .text_color(this.tree.offline ? t.ansi3 : t.muted).child(this.tree.offline ? `${on} · offline` : on)))
      .when(Boolean(this.doc && (this.doc.kind === "markdown" || this.doc.kind === "text")), (el) =>
        el.child(this.button("fp-find-doc", "search-doc.svg", t, (_e, cx) => this.openDocFind(cx))))
      .child(this.textButton("fp-text-out", "A−", t, (_e, cx) => this.textAct("out", cx)))
      .child(div().id("fp-text-pct").w(40).flex_none().rounded(4).text_center().text_size(11.5).cursor_pointer().hover((s) => s.bg(t.hover))
        .text_color(this.textZoom === 1 ? t.dim : t.foreground).on_click((_e, cx) => this.textAct("reset", cx))
        .child(`${Math.round(this.textZoom * 100)}%`))
      .child(this.textButton("fp-text-in", "A+", t, (_e, cx) => this.textAct("in", cx)))
      .child(this.button("fp-reload", "reload.svg", t, (_e, cx) => this.reload(cx)))
      .when(Boolean(this.overlay), (el) => el.child(this.button("fp-anchor", "anchor.svg", t, () => this.anchor())))
      .child(this.button("fp-close", "close.svg", t, () => this.closeView()));
  }

  row(r, t, focus) {
    const md = !r.dir && lang.isMarkdown(r.name), code = !r.dir && lang.forPath(r.name);
    const open = r.dir && this.tree.expanded.has(r.path);
    const icon = r.dir ? (open ? "folder-open.svg" : "folder.svg") : md ? "file-md.svg" : code ? "file-code.svg" : "file.svg";
    // Git: a file gets its letter, a folder with changes below it a dot; both tint the name.
    const g = this.git ? (r.dir ? this.git.folders : this.git.files).get(r.path) : undefined;
    const tint = g ? gitColor(g, t) : null;
    return h_flex().h(ROW).w_full().pl(6 + r.depth * 14).pr(8).gap(5).items_center()
      .when(r.path === this.cursor, (el) => el.bg(focus ? t.selected : t.hover))
      .child(r.dir ? svg(ICON + (open ? "chevron-down.svg" : "chevron-right.svg")).size(11).flex_none().text_color(t.dim) : div().w(11).flex_none())
      .child(svg(ICON + icon).size(14).flex_none().text_color(md ? t.accent : r.dir ? t.muted : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(r.path === this.file ? t.accent : r.denied ? t.dim : tint ?? t.foreground).child(r.name))
      .when(r.denied, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("no access")))
      .when(Boolean(tint) && !r.dir, (el) => el.child(div().w(12).flex_none().text_center().text_size(11).font_medium().text_color(tint).child(g)))
      .when(Boolean(tint) && r.dir, (el) => el.child(h_flex().w(12).flex_none().justify_center().child(div().size(5).rounded_full().bg(tint))));
  }

  /** The hidden tree's strip (and a narrow view's), with its toggle. */
  strip(t) {
    return v_flex().id("fp-strip").w(STRIP_W).flex_none().h_full().items_center().pt(4).border_r(1).border_color(t.border).bg(t.chrome)
      .child(this.button("fp-tree-toggle", this.treeShown() ? "folder-open.svg" : "folder.svg", t, (_e, cx) => { this.toggleTree(); cx.notify(); }));
  }

  treePane(rows, t, w) {
    const focus = this.treeFocus.is_focused();
    const tree = this.tree, ts = this.ts, searching = Boolean(ts?.query.trim());
    const empty = searching ? null : tree.error || (!tree.loaded ? (tree.offline ? null : this.ctx?.cwd || this.loadingTree ? "Loading files…" : "No folder") : rows.length ? null : "Empty folder");
    return v_flex().id("fp-tree-pane").w(w).flex_none().h_full().min_h(0).border_r(1).border_color(t.border).bg(t.chrome).text_size(12.5)
      .track_focus(this.treeFocus).on_key_down((e, cx) => this.onKey(e, cx, "tree"))
      .key_context(TREE_CONTEXT).on_action(FIND_OPEN, (_e, cx) => this.openTreeFind(cx))
      .when(Boolean(ts), (el) => el.child(this.findBar("tree", t)))
      .when(Boolean(tree.offline), (el) => el.child(v_flex().flex_none().px(10).py(6).gap(4).border_b(1).border_color(t.border).text_size(11.5)
        .child(div().text_color(t.ansi3).child(tree.offline))
        .child(h_flex().gap(8).text_color(t.dim)
          .child(div().id("fp-retry-offline").cursor_pointer().text_color(t.accent).on_click((_e, cx) => this.reload(cx)).child("Retry"))
          .when(tree.loaded, (el) => el.child("showing the last loaded tree")))))
      .when(searching, (el) => el.child(this.findResults(t)))
      .when(!searching && rows.length > 0, (el) => el.child(div().flex_1().min_h(0).relative().py(4)
        .child(v_virtual_list("fp-tree", rows.length, ROW, (i) => rows[i].path,
          (range) => rows.slice(range.start, range.end).map((r) => this.row(r, t, focus)))
          .track_scroll(this.scroll).on_item_click((key, cx) => this.click(key, cx)).size_full())
        .child(Scrollbar.vertical("fp-tree").viewport_from_layout().absolute().inset_0())))
      .when(Boolean(empty), (el) => el.child(v_flex().p(10).gap(8).text_color(t.dim).child(empty)
        .when(Boolean(tree.error), (el) => el.child(div().id("fp-retry").cursor_pointer().text_color(t.accent).on_click((_e, cx) => this.reload(cx)).child("Retry")))))
      .when(tree.limited && !searching, (el) => el.child(div().flex_none().px(10).py(4).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(`Limited to ${PER_FOLDER} entries per folder and ${TOTAL.toLocaleString("en-US")} in total`)));
  }

  /**
   * A search field with its own key context: the bound Esc closes only the search, and the
   * keys typed into it never reach the pane's shortcuts.
   */
  findBar(side, t) {
    const st = side === "tree" ? this.ts : this.ds;
    const close = (cx) => { if (side === "tree") this.closeTreeFind(cx); else { this.closeDocFind(); cx.notify(); } };
    let info = null;
    if (side === "doc" && st.query) {
      const where = this.doc?.kind === "text" ? "line" : "block";
      info = st.total ? `${matches(st.total)} in ${plural(st.hits.length, where)}` : "No matches";
    }
    return h_flex().id(`fp-find-${side}`).h(32).flex_none().w_full().pl(8).pr(4).gap(4).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .key_context(FIND_CONTEXT).on_action(FIND_ESCAPE, (_e, cx) => close(cx))
      .on_key_down((e, cx) => this.findKey(e, cx, side))
      .child(h_flex().flex_1().min_w(0).h(24).px(6).gap(6).items_center().rounded(5).border_1().border_color(t.accent).bg(t.background)
        .child(svg(ICON + "search.svg").size(12).flex_none().text_color(t.dim))
        .child(Input.new(st.input).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground)))
      .when(Boolean(info), (el) => el.child(div().flex_none().px(4).text_size(11).text_color(st.total ? t.muted : t.ansi3).child(info)))
      .when(side === "doc" && st.hits.length > 0, (el) => el
        .child(this.textButton("fp-find-prev", "↑", t, (_e, cx) => { this.docStep(-1); cx.notify(); }))
        .child(this.textButton("fp-find-next", "↓", t, (_e, cx) => { this.docStep(1); cx.notify(); })))
      .child(this.button(`fp-find-${side}-close`, "close.svg", t, (_e, cx) => close(cx)));
  }

  /** The tree search's results: a flat list of paths, best first, in place of the tree. */
  findResults(t) {
    const ts = this.ts, f = this.ctx?.files, list = ts.results;
    let foot;
    if (!f?.data) foot = f?.error ? `Cannot list the files: ${f.error}` : "Listing files…";
    else if (!list.length) foot = "No matching files";
    else foot = (ts.total > list.length ? `Best ${list.length} of ${ts.total.toLocaleString("en-US")} matches` : matches(ts.total))
      + ` · ${f.data.paths.length.toLocaleString("en-US")}${f.data.truncated ? "+" : ""} files`;
    return v_flex().flex_1().min_h(0)
      .when(list.length > 0, (el) => el.child(div().flex_1().min_h(0).relative().py(4)
        .child(v_virtual_list("fp-find-list", list.length, ROW, (i) => "find:" + list[i].path,
          (range) => list.slice(range.start, range.end).map((r, k) => this.resultRow(r, range.start + k === ts.at, t)))
          .track_scroll(this.findScroll).on_item_click((key, cx) => this.findClick(key.slice(5), cx)).size_full())
        .child(Scrollbar.vertical("fp-find-list").viewport_from_layout().absolute().inset_0())))
      .when(!list.length, (el) => el.child(div().flex_1()))
      .child(div().flex_none().px(10).py(4).border_t(1).border_color(t.border).text_size(11)
        .text_color(f?.error ? t.ansi3 : t.dim).child(foot));
  }

  /** A result: the name with its matched letters in the accent, then its folder, dimmed. */
  resultRow(r, sel, t) {
    const cut = r.path.lastIndexOf("/") + 1, name = r.path.slice(cut), dir = r.path.slice(0, Math.max(0, cut - 1));
    const hit = new Set(r.hits), spans = [];
    for (let i = 0; i < name.length;) {
      const on = hit.has(cut + i);
      let j = i + 1;
      while (j < name.length && hit.has(cut + j) === on) j++;
      const piece = div().flex_none().whitespace_nowrap().child(name.slice(i, j));
      spans.push(on ? piece.text_color(t.accent).font_bold() : piece);
      i = j;
    }
    const md = lang.isMarkdown(name), code = lang.forPath(name);
    const g = this.git?.files.get(r.path), tint = g ? gitColor(g, t) : null;
    return h_flex().h(ROW).w_full().pl(8).pr(8).gap(5).items_center().when(sel, (el) => el.bg(t.selected))
      .child(svg(ICON + (md ? "file-md.svg" : code ? "file-code.svg" : "file.svg")).size(14).flex_none().text_color(md ? t.accent : t.dim))
      .child(h_flex().flex_none().max_w("70%").overflow_hidden().text_color(r.path === this.file ? t.accent : tint ?? t.foreground).children(spans))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))
      .when(Boolean(tint), (el) => el.child(div().w(12).flex_none().text_center().text_size(11).font_medium().text_color(tint).child(g)));
  }

  message(t, text, sub) {
    return v_flex().flex_1().items_center().justify_center().gap(6).text_color(t.dim)
      .child(div().text_size(14).child(text)).when(Boolean(sub), (el) => el.child(div().text_size(11.5).child(sub)));
  }

  /**
   * A fence: header (language, Copy) over a readonly Editor. A code Editor always lets its
   * text scroll past the end by max(half its height, 3 rows), so it is laid out that much
   * taller than its text inside a box clipped to the text: it never scrolls vertically, and
   * the wheel goes on to the document.
   */
  codeBlock(b, i, t) {
    const id = b.kind === "mmd" ? `${b.id}-src` : `code-${i}`, lh = lineHeight(this.codeFont), pad = Math.round(CODE_PAD * this.textZoom);
    const text = this.rows(b) * lh, slack = Math.max(text, 3 * lh);
    const copied = Boolean(b.copied);
    return v_flex().id(id).w_full().flex_none().rounded(6).border_1().border_color(t.border).bg(t.background).overflow_hidden()
      .child(h_flex().h(24).pl(10).pr(3).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(lang.fenceLabel(b.kind === "mmd" ? "mermaid" : b.info)))
        .child(h_flex().id(`${id}-copy`).h(20).flex_none().px(5).gap(4).rounded(4).items_center().cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.copyBlock(b, cx))
          .child(svg(ICON + (copied ? "check.svg" : "copy.svg")).size(13).text_color(copied ? t.done : t.muted))
          .when(copied, (el) => el.child(div().text_size(11).text_color(t.done).child("Copied")))))
      .child(div().w_full().h(text + 2 * pad).flex_none().py(pad)
        .child(div().w_full().h(text).overflow_hidden().relative()
          .child(div().w_full().h(text + slack).flex_none().child(Editor.new(b.state).size_full()))
          // Rows with matches, when rows are lines (no soft wrap).
          .when(Boolean(b.find) && !b.wrap, (e) => e.children(this.lineMarks(b.find.rows, lh, b.find.current, t)))));
  }

  /** The fences that show as code boxes, in document order (Mermaid sources only when shown). */
  codeBoxes() {
    return this.blocks.filter((b) => b.state && (b.kind === "code" || b.d?.error));
  }

  /** Copies a fence's text (without the fence lines); the button says "Copied" for a moment. */
  copyBlock(b, cx) {
    cx.write_to_clipboard(b.text);
    const mark = (b.copied ?? 0) + 1;
    b.copied = mark;
    cx.timer.after(COPIED_MS, (cx) => { if (b.copied !== mark) return; b.copied = 0; cx.notify(); });
    cx.notify();
  }

  diagramBlock(b, i, t) {
    const d = b.d ?? { pending: true };
    if (d.ok) {
      // Rendered at -s 2: half the PNG width is crisp; no h / w_full on the image. The box
      // reserves the final height, also while image() decodes the PNG.
      const s = this.diagramSize(d.w, d.h), n = this.blocks.filter((o) => o.kind === "mmd").indexOf(b);
      const right = Math.max(0, Math.floor(((this.colW ?? s.w) - s.w) / 2));   // the image's top-right corner
      return h_flex().id(b.id).w_full().h(s.h + 8).flex_none().justify_center().py(4).relative().child(image(d.path).w(s.w))
        .child(this.button(`${b.id}-expand`, "expand.svg", t, (_e, cx) => this.expandDiagram(n, cx)).absolute().top(4).right(right).bg(t.raised));
    }
    if (d.error && b.state) {
      return v_flex().id(b.id).w_full().flex_none().gap(6)
        .child(h_flex().w_full().px(10).py(6).gap(10).items_start().rounded(6).border_1().border_color(t.border).bg(t.raised).text_size(11.5)
          .child(div().flex_1().min_w(0).text_color(d.setup ? t.ansi3 : t.ansi1)
            .when(typeof settings().font_family === "string" && !d.setup, (el) => el.font_family(String(settings().font_family))).child(d.error))
          .child(div().id(`${b.id}-retry`).flex_none().cursor_pointer().text_color(t.accent).on_click((_e, cx) => this.retryDiagram(b, cx)).child("Retry")))
        .child(this.codeBlock(b, i, t));
    }
    // Pending: never ask image() for a PNG that doesn't exist yet (it would stay blank).
    // A diagram rendered before (sizes.json) reserves its final height; a new one, an estimate.
    const known = b.key ? this.mermaid.size(b.key) : null;
    return h_flex().id(b.id).w_full().h(known ? this.diagramSize(known.w, known.h).h + 8 : Math.round(Math.min(240, 40 + b.lines * 12) * this.textZoom)).flex_none().gap(8).items_center().justify_center()
      .rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.dim)
      .child(div().w(12).flex_none().text_color(t.accent).frames(SPIN, 90).child(SPIN[0]))
      .child("Rendering diagram…");
  }

  previewPane(t, narrow) {
    const doc = this.doc;
    let body;
    if (!this.file) body = this.message(t, "Select a file", "↑ ↓ move · → ← open/close folder · Enter open · Tab tree/preview · b show/hide tree · / find · + − 0 zoom · r reload" + (this.overlay ? " · Esc close" : ""));
    else if (!doc) body = this.message(t, "Loading…");
    else if (doc.kind === "markdown")
      body = v_flex().id(`doc:${this.file}`).flex_1().min_h(0).overflow_y_scrollbar()
        .child(h_flex().w_full().justify_center().px(narrow ? 12 : 24).py(narrow ? 12 : 20)
          .child(v_flex().id("fp-col").w_full().max_w(860).gap(Math.round(12 * this.textZoom)).text_size(this.proseSize())
            .on_size_change((size, cx) => { if (Math.round(size.width) !== this.colW) { this.colW = Math.round(size.width); cx.notify(); } })
            .children(this.blocks.map((b, i) => this.marked(b, t, b.kind === "md"
              ? TextView.markdown(`md-${i}`, b.text).selectable(true).on_link_click((url, cx) => this.link(url, cx))
              : b.kind === "mmd" ? this.diagramBlock(b, i, t) : this.codeBlock(b, i, t))))));
    else if (doc.kind === "text" && this.code) body = this.codeView(t);
    else body = this.message(t, doc.message ?? "Cannot preview this file");
    return v_flex().id("fp-preview-pane").flex_1().min_w(0).h_full().min_h(0).bg(t.surface)
      .track_focus(this.previewFocus).on_key_down((e, cx) => this.onKey(e, cx, "preview"))
      .key_context(DOC_CONTEXT).on_action(FIND_OPEN, (_e, cx) => this.openDocFind(cx))
      .when(Boolean(this.ds), (el) => el.child(this.findBar("doc", t)))
      .child(body);
  }

  /**
   * A Markdown block with its git marks, drawn in the column's side padding so nothing moves:
   * a bar for added or modified lines, a red triangle where lines were deleted.
   */
  marked(b, t, el) {
    const m = b.mark;
    return v_flex().w_full().flex_none().relative().child(el)
      .when(Boolean(m?.bar), (e) => e.child(div().absolute().top(0).bottom(0).left(-BAR_X).w(3).rounded(1).bg(barColor(m.bar, t))))
      .when(Boolean(m?.top), (e) => e.child(svg(ICON + "deleted.svg").size(7).absolute().top(-4).left(-BAR_X - 1).text_color(t.ansi1)))
      .when(Boolean(m?.bottom), (e) => e.child(svg(ICON + "deleted.svg").size(7).absolute().bottom(-4).left(-BAR_X - 1).text_color(t.ansi1)))
      // Search: a bar in the right padding; the current block also gets a frame.
      .when(Boolean(b.find), (e) => e.child(div().absolute().top(0).bottom(0).right(b.find.current ? -BAR_X - 1 : -BAR_X).w(b.find.current ? 5 : 3).rounded(2).bg(t.accent)))
      .when(Boolean(b.find?.current), (e) => e.child(div().absolute().top(-4).bottom(-4).left(-4).right(-4).rounded(6).border_1().border_color(t.accent)));
  }

  /** How the code view lays out: "full" (line gutter, outer scroll) or "plain" (the Editor scrolls; ruler). */
  codeLayout() {
    if (!this.git || !this.doc || lang.wraps(lang.forPath(this.file ?? ""))) return "plain";
    return this.doc.lines <= FULL_MAX ? "full" : "plain";
  }

  /**
   * The whole-file Editor. In a repo it is laid out at its full height (taller than its text, so
   * it never scrolls itself) inside a scrolling box, next to a gutter of changed lines that
   * scrolls with it. Past FULL_MAX lines, or soft-wrapped, it keeps its own scroll and the
   * changes go on an overview ruler at the right edge.
   */
  codeView(t) {
    const editor = Editor.new(this.code).size_full(), m = this.codeMarks, ds = this.ds;
    const hits = ds?.hits.length ? ds.hits : null, cur = hits ? hits[ds.at].line : 0;
    if (this.codeLayout() === "plain") {
      const box = div().flex_1().min_w(0).h_full().child(editor);
      if (!this.git && !hits) return div().flex_1().min_h(0).size_full().child(box);
      // Rows [from, from + n) as a share of the strip; the lower half hangs from the bottom so a
      // 2 px minimum never pokes out of the strip.
      const rows = Math.max(1, this.doc.lines), pct = (n) => `${(100 * n) / rows}%`;
      const at = (el, from, n) => (2 * from + n <= rows ? el.top(pct(from)) : el.bottom(pct(rows - from - n)));
      return h_flex().flex_1().min_h(0).size_full().child(box)
        .when(Boolean(this.git), (el) => el.child(div().w(RULER).flex_none().h_full().relative().border_l(1).border_color(t.border)
          .when(Boolean(m), (e) => e
            .children(m.runs.map((r) => at(div().absolute().left(2).w(RULER - 4).h(pct(r.n)).min_h(2).bg(barColor(r.kind, t)), r.from - 1, r.n)))
            .children(m.dels.map((n) => at(div().absolute().left(1).w(RULER - 2).h(2).bg(t.ansi1), n, 0))))))
        // Search: a strip of its own, so its marks never cover the git ones.
        .when(Boolean(hits), (el) => el.child(div().w(RULER).flex_none().h_full().relative().border_l(1).border_color(t.border)
          .children(hits.map((h) => at(div().absolute().left(h.line === cur ? 0 : 2).w(h.line === cur ? RULER : RULER - 4).h(pct(1))
            .min_h(h.line === cur ? 4 : 2).bg(h.line === cur ? t.foreground : t.accent), h.line - 1, 1)))));
    }
    const lh = lineHeight(this.codeFont), text = this.doc.lines * lh, slack = Math.max(text, 3 * lh);
    return div().id(`code:${this.file}`).flex_1().min_h(0).size_full().overflow_y_scrollbar()
      .child(h_flex().w_full().h(text).flex_none().items_start()
        .child(div().w(GUTTER).h(text).flex_none().relative()
          .when(Boolean(m), (e) => e
            .children(m.runs.map((r) => div().absolute().left(3).w(3).top((r.from - 1) * lh).h(r.n * lh).bg(barColor(r.kind, t))))
            .children(m.dels.map((n) => svg(ICON + "deleted.svg").size(7).absolute().left(1).top(Math.max(0, Math.min(text - 7, n * lh - 3.5))).text_color(t.ansi1)))))
        .child(div().flex_1().min_w(0).h(text).overflow_hidden().relative()
          .child(div().w_full().h(text + slack).flex_none().child(editor))
          .when(Boolean(hits), (e) => e.children(this.lineMarks(hits.map((h) => h.line - 1), lh, false, t, cur - 1)))));
  }

  /**
   * Rows (from 0) with matches, aligned on the text: a tint across the row and a bar at the
   * right edge. `current` marks them all as the current block; `at`, one row.
   */
  lineMarks(rows, lh, current, t, at = -1) {
    const soft = tint(t.accent, "22"), strong = tint(t.accent, "44");
    return rows.flatMap((r) => {
      const on = current || r === at, out = [];
      const bg = on ? strong : soft;
      if (bg) out.push(div().absolute().left(0).right(0).top(r * lh).h(lh).bg(bg));
      out.push(div().absolute().right(0).w(on ? 4 : 2).top(r * lh).h(lh).bg(t.accent));
      return out;
    });
  }

  statusBar(t) {
    const doc = this.doc, parts = [];
    if (this.file && (!doc || doc.kind === "markdown" || doc.kind === "text")) parts.push(lang.label(this.file));
    if (doc?.truncated) parts.push(`Truncated: showing the first ${(LIMIT / 1e6).toFixed(0)} MB${doc.size ? ` of ${(doc.size / 1e6).toFixed(1)} MB` : ""}`);
    if (doc?.kind === "markdown") {
      const n = this.blocks.filter((b) => b.kind === "code").length;
      if (n) parts.push(plural(n, "code block"));
      const m = this.blocks.filter((b) => b.kind === "mmd"), busy = m.filter((b) => b.d?.pending).length;
      if (m.length) parts.push(busy ? `Rendering ${plural(busy, "diagram")}…` : plural(m.length, "diagram"));
    }
    const where = this.docWhere();
    if (where) parts.push(`Find: ${where}`);
    if (this.note) parts.push(this.note);
    if (this.file && this.loadedAt && doc && doc.kind !== "missing") parts.push(ago(this.loadedAt));
    if (this.ctx?.polling) parts.push("polling (folder too big to watch)");
    return h_flex().h(22).flex_none().px(10).gap(10).items_center().overflow_hidden().border_t(1).border_color(t.border).bg(t.chrome).text_size(11).text_color(t.dim)
      .when(this.loadingFile || this.loadingTree || this.blocks.some((b) => b.d?.pending), (el) => el.child(div().w(10).flex_none().text_color(t.accent).frames(SPIN, 90).child(SPIN[0])))
      .child(div().flex_none().max_w(480).truncate().text_color(this.file ? t.muted : t.dim).child(this.file ?? "No file"))
      .children(parts.map((p) => div().flex_none().child("· " + p)))
      .child(div().flex_1())
      .child(div().flex_none().child(this.treeFocus.is_focused() ? "tree" : this.previewFocus.is_focused() ? "preview" : ""));
  }
}
