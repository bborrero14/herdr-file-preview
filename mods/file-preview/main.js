// A tree of the focused terminal's folder and a rendered preview of the chosen file:
// Markdown (prose in TextView, fences highlighted in readonly Editors, Mermaid as PNG) and code.
// It follows the focused terminal (local or remote space) and reloads what it shows when it changes.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, props, closeOverlay, nextCommand, home, window, run } from "herdr";
import { Tree, parent, PER_FOLDER, TOTAL } from "./tree.js";
import { readSource, stamp, LIMIT } from "./source.js";
import { segment } from "./markdown.js";
import * as lang from "./lang.js";
import { Mermaid, fnv1a, cacheKey, themeOf } from "./mermaid.js";
import { dock, panelOf, size } from "./dock.js";

const ICON = "mods/file-preview/icons/";
const ROW = 22;              // tree row height
const FONT = 12, LH = 19;    // code font size and its measured line height
const CH = FONT * 0.6;       // mono char width, for soft-wrapped fence heights
const WRAP_PAD = 24;         // fence width the Editor leaves without text (calibrated: 860 px → 116 cols)
const MAX_EDITORS = 300;
const MAX_DIAGRAM_W = 600;   // diagram display width cap (logical px), besides the column and half the PNG     // fences past this stay in the prose, uncolored
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEBOUNCE = 200, MAX_WAIT = 1000;   // live reload: agents write in bursts
const POLL_FILE = 2500, POLL_TREE = 10000;
const TREE_W = 260, NARROW = 600;   // below NARROW px the tree folds into a strip
const STRIP_W = 28, NARROW_TREE_W = 220;

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

function syntax() {
  const t = theme();
  return { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
}

export default class FilePreview extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.overlay = p.overlay ?? null;
    this.mode = p.mode ?? "popup";
    this.treeFocus = cx.focus_handle();
    this.previewFocus = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.cursor = null;     // keyboard row (rel path)
    this.file = null;       // shown file (rel path)
    this.doc = null;        // what readSource returned, plus segments for Markdown
    this.blocks = [];       // [{ kind: "md", text } | { kind: "code", info, lines, state }]
    this.code = null;       // EditorState of a code/text file
    this.seq = 0;           // bumps on every file load; late results are dropped
    this.stamp = null;      // "<mtime> <size>" of the shown file, when polled
    this.loadedAt = null;   // when the shown content last changed
    this.dark = settings().dark;
    this.colW = null;       // measured width of the Markdown column (for diagram sizes)
    this.width = null;      // measured width of the whole view
    // Narrow view: the tree is unfolded. A 45 % panel is ~550 px on a 1512 px window, so it starts
    // open unless a file comes with the props (the popup's Anchor).
    this.treeOpen = typeof p.file !== "string";
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

  async close() {
    this.closed = true;
    this.mermaid.close();
    this.release();
    this.seq++;
    if (this.ctx) this.stop(this.ctx);
    this.ctx = null;
    this.scroll?.release();
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
    this.cursor = null;
    this.show(null);
    if (cwd) { this.refreshTree(this.ctx, null, cx, true); return; }
    // A remote space without a folder: its home, asked once.
    const c = this.ctx, tree = this.tree;
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
    if (reread && file) this.show(file, cx, { quiet: true });
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
      this.show(rel, cx, opts);
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
    if (rel !== this.file) { this.release(); this.doc = null; this.stamp = null; this.loadedAt = null; }
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
      cx.notify();
    });
  }

  /** What build() makes of this.doc's segments, without EditorStates. */
  plan(segments) {
    const out = [], seen = new Map();
    let editors = 0;
    for (const s of segments) {
      if (s.kind === "md") { out.push(s); continue; }
      const mermaid = s.info.toLowerCase() === "mermaid";
      if (editors >= MAX_EDITORS) { out.push({ kind: "md", text: "```" + s.info + "\n" + s.text + "\n```" }); continue; }
      editors++;
      const lines = Math.max(1, s.text.split("\n").length);
      // A wrapped fence's height follows the column width (rows()).
      if (!mermaid) { out.push({ kind: "code", info: s.info, text: s.text, lines, wrap: lang.wraps(lang.forFence(s.info)) }); continue; }
      // Diagrams are compared by source: unchanged ones keep their render across a reload.
      const hash = fnv1a(s.text), n = (seen.get(hash) ?? 0) + 1;
      seen.set(hash, n);
      out.push({ kind: "mmd", info: s.info, text: s.text, lines, hash, id: n === 1 ? `mmd-${hash}` : `mmd-${hash}-${n}` });
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
        if (old.hash === b.hash) { old.id = b.id; return; }   // same diagram: keep its render
        old.state?.release();
        this.blocks[i] = b;
        return;
      }
      if (old.text !== b.text) old.state.set_value(b.text);
      old.text = b.text; old.lines = b.lines; old.vis = null;
    });
    this.diagrams(cx);
    return true;
  }

  /** (Re)creates the EditorStates for this.doc. Never called from render itself. */
  build(cx) {
    this.release();
    const doc = this.doc;
    if (!doc) return;
    const base = { readonly: true, font_family: settings().font_family, font_size: FONT, syntax: syntax() };
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
    return EditorState.new({ readonly: true, font_family: settings().font_family, font_size: FONT, syntax: syntax(),
      ...(language ? { language } : {}), value, line_numbers: false, folding: false, soft_wrap: lang.wraps(language) });
  }

  /** Visual rows of a fence; a soft-wrapped one depends on the measured column width. */
  rows(b) {
    if (!b.wrap || !this.colW) return b.lines;
    const cols = Math.max(1, Math.floor((this.colW - WRAP_PAD) / CH));
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
    const dw = Math.max(1, Math.min(this.colW ?? 812, w / 2, MAX_DIAGRAM_W));
    return { w: dw, h: (dw * h) / w };
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
    const m = e.modifiers;
    if (m.platform || m.control || m.alt) return;
    if (e.key === "escape") { if (this.overlay) closeOverlay(this.overlay); return; }
    let used;
    if (where === "tree") used = this.treeKey(e.key, cx);
    else if (e.key === "tab") { this.focusTree(true); used = true; }
    else if (e.key === "r") { this.reload(cx); used = true; }
    else if (e.key === "b") { this.toggleTree(); used = true; }
    if (used) { cx.stop_propagation(); cx.notify(); }
  }

  // ---- panel ----------------------------------------------------------

  narrow() { return this.width !== null && this.width < NARROW; }
  treeShown() { return !this.narrow() || this.treeOpen; }

  /** Tree focus; in a narrow view with the tree folded, the preview (open: unfold it first). */
  focusTree(open = false) {
    if (!this.treeShown() && open) this.treeOpen = true;
    (this.treeShown() ? this.treeFocus : this.previewFocus).focus();
  }

  toggleTree() {
    if (!this.narrow()) return;          // a wide view always shows the tree
    this.treeOpen = !this.treeOpen;
    (this.treeOpen ? this.treeFocus : this.previewFocus).focus();
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
    this.follow(cx);
    const t = theme();
    if (settings().dark !== this.dark) {
      // Theme flipped: syntax colors are baked into the EditorStates, so rebuild them (outside render).
      this.dark = settings().dark;
      cx.spawn(async (cx) => { this.build(cx); cx.notify(); });
    }
    const rows = this.tree.rows(), narrow = this.narrow();
    return v_flex().id("fp-root").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => this.sized(size, cx))
      .child(this.topBar(t))
      .child(h_flex().flex_1().min_h(0)
        .when(narrow, (el) => el.child(this.strip(t)))
        .when(this.treeShown(), (el) => el.child(this.treePane(rows, t, narrow ? Math.min(NARROW_TREE_W, Math.round(this.width * 0.55)) : TREE_W)))
        .child(this.previewPane(t, narrow)))
      .child(this.statusBar(t));
  }

  button(id, icon, t, onClick) {
    return h_flex().id(id).size(22).flex_none().rounded(5).items_center().justify_center().cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(onClick).child(svg(ICON + icon).size(14).text_color(t.muted));
  }

  topBar(t) {
    const on = this.ctx?.on;
    return h_flex().h(28).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(svg(ICON + "folder.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(tilde(this.tree.root) || "No folder"))
      .when(Boolean(on), (el) => el.child(div().flex_none().px(6).rounded(4).bg(t.raised).text_size(11)
        .text_color(this.tree.offline ? t.ansi3 : t.muted).child(this.tree.offline ? `${on} · offline` : on)))
      .child(this.button("fp-reload", "reload.svg", t, (_e, cx) => this.reload(cx)))
      .when(Boolean(this.overlay), (el) => el.child(this.button("fp-anchor", "anchor.svg", t, () => this.anchor())))
      .child(this.button("fp-close", "close.svg", t, () => this.closeView()));
  }

  row(r, t, focus) {
    const md = !r.dir && lang.isMarkdown(r.name), code = !r.dir && lang.forPath(r.name);
    const open = r.dir && this.tree.expanded.has(r.path);
    const icon = r.dir ? (open ? "folder-open.svg" : "folder.svg") : md ? "file-md.svg" : code ? "file-code.svg" : "file.svg";
    return h_flex().h(ROW).w_full().pl(6 + r.depth * 14).pr(8).gap(5).items_center()
      .when(r.path === this.cursor, (el) => el.bg(focus ? t.selected : t.hover))
      .child(r.dir ? svg(ICON + (open ? "chevron-down.svg" : "chevron-right.svg")).size(11).flex_none().text_color(t.dim) : div().w(11).flex_none())
      .child(svg(ICON + icon).size(14).flex_none().text_color(md ? t.accent : r.dir ? t.muted : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(r.path === this.file ? t.accent : r.denied ? t.dim : t.foreground).child(r.name))
      .when(r.denied, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("no access")));
  }

  /** Narrow view: the folded tree's strip, with its toggle. */
  strip(t) {
    return v_flex().id("fp-strip").w(STRIP_W).flex_none().h_full().items_center().pt(4).border_r(1).border_color(t.border).bg(t.chrome)
      .child(this.button("fp-tree-toggle", this.treeOpen ? "folder-open.svg" : "folder.svg", t, (_e, cx) => { this.toggleTree(); cx.notify(); }));
  }

  treePane(rows, t, w) {
    const focus = this.treeFocus.is_focused();
    const tree = this.tree;
    const empty = tree.error || (!tree.loaded ? (tree.offline ? null : this.ctx?.cwd || this.loadingTree ? "Loading files…" : "No folder") : rows.length ? null : "Empty folder");
    return v_flex().id("fp-tree-pane").w(w).flex_none().h_full().min_h(0).border_r(1).border_color(t.border).bg(t.chrome).text_size(12.5)
      .track_focus(this.treeFocus).on_key_down((e, cx) => this.onKey(e, cx, "tree"))
      .when(Boolean(tree.offline), (el) => el.child(v_flex().flex_none().px(10).py(6).gap(4).border_b(1).border_color(t.border).text_size(11.5)
        .child(div().text_color(t.ansi3).child(tree.offline))
        .child(h_flex().gap(8).text_color(t.dim)
          .child(div().id("fp-retry-offline").cursor_pointer().text_color(t.accent).on_click((_e, cx) => this.reload(cx)).child("Retry"))
          .when(tree.loaded, (el) => el.child("showing the last loaded tree")))))
      .when(rows.length > 0, (el) => el.child(div().flex_1().min_h(0).relative().py(4)
        .child(v_virtual_list("fp-tree", rows.length, ROW, (i) => rows[i].path,
          (range) => rows.slice(range.start, range.end).map((r) => this.row(r, t, focus)))
          .track_scroll(this.scroll).on_item_click((key, cx) => this.click(key, cx)).size_full())
        .child(Scrollbar.vertical("fp-tree").viewport_from_layout().absolute().inset_0())))
      .when(Boolean(empty), (el) => el.child(v_flex().p(10).gap(8).text_color(t.dim).child(empty)
        .when(Boolean(tree.error), (el) => el.child(div().id("fp-retry").cursor_pointer().text_color(t.accent).on_click((_e, cx) => this.reload(cx)).child("Retry")))))
      .when(tree.limited, (el) => el.child(div().flex_none().px(10).py(4).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(`Limited to ${PER_FOLDER} entries per folder and ${TOTAL.toLocaleString("en-US")} in total`)));
  }

  message(t, text, sub) {
    return v_flex().flex_1().items_center().justify_center().gap(6).text_color(t.dim)
      .child(div().text_size(14).child(text)).when(Boolean(sub), (el) => el.child(div().text_size(11.5).child(sub)));
  }

  codeBlock(b, i, t) {
    return v_flex().id(b.kind === "mmd" ? `${b.id}-src` : `code-${i}`).w_full().flex_none().rounded(6).border_1().border_color(t.border).bg(t.background).overflow_hidden()
      .child(h_flex().h(22).px(10).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child(b.info || "text")))
      .child(div().w_full().h(this.rows(b) * LH + 8).child(Editor.new(b.state).size_full()));
  }

  diagramBlock(b, i, t) {
    const d = b.d ?? { pending: true };
    if (d.ok) {
      // Rendered at -s 2: half the PNG width is crisp; no h / w_full on the image. The box
      // reserves the final height, also while image() decodes the PNG.
      const s = this.diagramSize(d.w, d.h);
      return h_flex().id(b.id).w_full().h(s.h + 8).flex_none().justify_center().py(4).child(image(d.path).w(s.w));
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
    return h_flex().id(b.id).w_full().h(known ? this.diagramSize(known.w, known.h).h + 8 : Math.min(240, 40 + b.lines * 12)).flex_none().gap(8).items_center().justify_center()
      .rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.dim)
      .child(div().w(12).flex_none().text_color(t.accent).frames(SPIN, 90).child(SPIN[0]))
      .child("Rendering diagram…");
  }

  previewPane(t, narrow) {
    const doc = this.doc;
    let body;
    if (!this.file) body = this.message(t, "Select a file", "↑ ↓ move · → ← open/close folder · Enter open · Tab tree/preview · b tree · r reload" + (this.overlay ? " · Esc close" : ""));
    else if (!doc) body = this.message(t, "Loading…");
    else if (doc.kind === "markdown")
      body = v_flex().id(`doc:${this.file}`).flex_1().min_h(0).overflow_y_scrollbar()
        .child(h_flex().w_full().justify_center().px(narrow ? 12 : 24).py(narrow ? 12 : 20)
          .child(v_flex().id("fp-col").w_full().max_w(860).gap(12)
            .on_size_change((size, cx) => { if (Math.round(size.width) !== this.colW) { this.colW = Math.round(size.width); cx.notify(); } })
            .children(this.blocks.map((b, i) => b.kind === "md"
              ? TextView.markdown(`md-${i}`, b.text).selectable(true).on_link_click((url, cx) => this.link(url, cx))
              : b.kind === "mmd" ? this.diagramBlock(b, i, t) : this.codeBlock(b, i, t)))));
    else if (doc.kind === "text" && this.code) body = div().flex_1().min_h(0).size_full().child(Editor.new(this.code).size_full());
    else body = this.message(t, doc.message ?? "Cannot preview this file");
    return v_flex().id("fp-preview-pane").flex_1().min_w(0).h_full().min_h(0).bg(t.surface)
      .track_focus(this.previewFocus).on_key_down((e, cx) => this.onKey(e, cx, "preview"))
      .child(body);
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
