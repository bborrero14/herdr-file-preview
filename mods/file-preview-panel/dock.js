// Docks file-preview as a right panel next to a terminal, for the launcher and the
// popup's Anchor button. Mods import only from their own folder, so
// mods/file-preview-panel/dock.js is a byte-for-byte copy (scripts/sync.sh refuses a mismatch).
import { spaces, panes, focused, run } from "herdr";

export const MOD = "file-preview";
export const WEIGHT = (0.5 * 45) / 55;   // a split's default weight is 0.5 a side → 45 % of it

/** The panel pane of a tab, if any. */
export function panelOf(tab) {
  return panes().find((p) => p.tab === tab && p.mod === MOD && !p.terminal) ?? null;
}

/** The terminal to split and its context: the focused one, else the focused tab's first. */
export function anchor() {
  const f = focused();
  if (!f) return null;                     // `herdr-app check`: no window
  const all = panes(), space = spaces().find((s) => s.active);
  const term = (f.pane && all.find((p) => p.pane === f.pane && p.terminal)) || all.find((p) => p.tab === f.tab && p.terminal);
  if (!term) return null;
  // A layout terminal block (pane null) names its machine in its address, like mods/files.
  const block = f.pane === null && f.terminal;
  const on = block ? (f.terminal.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { pane: term.pane, tab: f.tab, cwd: (block ? f.cwd : term.cwd) || f.cwd || space?.folder || null, on };
}

/**
 * Splits a panel right of the anchor terminal and sizes it. `extra` goes into its props
 * (file, or cwd/on to override the terminal's). Returns the new pane id, or null.
 */
export function dock(extra = {}) {
  const a = anchor();
  if (!a) return null;
  const before = new Set(panes().map((p) => p.pane));
  // The new pane isn't in panes() yet within this call, so the panel sizes itself from
  // props.resize; props.anchor lets it reset the terminal's weight too.
  run("pane.split", { direction: "right", pane: a.pane, mod: MOD, props: { mode: "panel", cwd: a.cwd, on: a.on, resize: WEIGHT, anchor: a.pane, ...extra } });
  const added = panes().find((p) => p.mod === MOD && !before.has(p.pane));
  if (added) size(added.pane, a.pane);
  return added?.pane ?? null;
}

/**
 * 45 % of the split: weights are relative between siblings, so an earlier resize of the
 * terminal would skew it; the terminal goes back to the default 0.5 first.
 */
export function size(pane, anchorPane) {
  if (anchorPane && panes().some((p) => p.pane === anchorPane)) run("layout.resize", { id: anchorPane, weight: 0.5 });
  run("layout.resize", { id: pane, weight: WEIGHT });
}

/** The launcher's toggle: closes the tab's panel, else docks one. */
export function toggle() {
  const f = focused();
  if (!f) return;
  const mine = panelOf(f.tab);
  if (mine) run("pane.close", { pane: mine.pane });
  else dock();
}
