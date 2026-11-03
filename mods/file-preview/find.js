// Search: the file list of a root (git or find, here or remote), fuzzy path matching, and
// case-insensitive matches in the shown document.
import { exec } from "herdr";

// Esc and cmd-f bound to these contexts outrank the app's bindings (Esc closes the popup).
export const FIND_CONTEXT = "FilePreviewFind", FIND_ESCAPE = "file_preview_find_escape";
export const TREE_CONTEXT = "FilePreviewTree", DOC_CONTEXT = "FilePreviewDoc", FIND_OPEN = "file_preview_find_open";

export const MAX_RESULTS = 200;
const MAX_GIT = 50000, MAX_FIND = 20000, DEPTH = 12, BYTES = 4000000;

// Prints "git\0" or "find\0", then NUL-separated paths relative to $1. Read-only git flags:
// nothing is written under .git, so the folder watch stays quiet.
const LIST = 'cd "$1" 2>/dev/null || exit 2; ' +
  'if command -v git >/dev/null 2>&1 && [ "$(git --no-optional-locks rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then ' +
  'printf "git\\0"; git --no-optional-locks -c core.fsmonitor=false -c core.quotepath=off ls-files --cached --others --exclude-standard -z 2>/dev/null | head -c ' + BYTES + '; exit 0; fi; ' +
  'printf "find\\0"; find . -maxdepth ' + DEPTH + ' -name .git -prune -o \\( -type f -o -type l \\) -print 2>/dev/null | head -n ' + MAX_FIND + ' | tr "\\n" "\\0"; exit 0';

/** -> { paths, lower, base, source: "git" | "find", truncated }; rejects when it can't run. */
export async function listFiles(root, on) {
  const r = await exec("sh", ["-c", LIST, "fp", root], { on });
  if (r.code !== 0) throw new Error((r.stderr || "Cannot list the files").trim());
  const f = r.stdout.split("\0"), source = f[0] === "git" ? "git" : "find", max = source === "git" ? MAX_GIT : MAX_FIND;
  let truncated = r.stdout.length >= BYTES || (source === "find" && f.length - 2 >= MAX_FIND);
  if (r.stdout.length >= BYTES) f.pop();   // the last path may be cut
  const seen = new Set(), paths = [];
  for (let i = 1; i < f.length; i++) {
    let p = f[i];
    if (!p) continue;
    if (p.startsWith("./")) p = p.slice(2);
    if (seen.has(p)) continue;              // ls-files repeats a path with conflicts
    seen.add(p);
    if (paths.length >= max) { truncated = true; break; }
    paths.push(p);
  }
  paths.sort();
  return { paths, lower: paths.map((p) => p.toLowerCase()), base: paths.map((p) => p.lastIndexOf("/") + 1), source, truncated };
}

const BOUNDARY = "/-_. ";

/** Score of hit positions in `s` (lowered), basename from `b`. */
function score(s, b, hits) {
  let n = 0;
  for (let k = 0; k < hits.length; k++) {
    const i = hits[k];
    n += 1;
    if (k > 0 && hits[k - 1] === i - 1) n += 4;
    if (i === 0 || BOUNDARY.includes(s[i - 1])) n += 3;
    if (i >= b) n += 2;
  }
  if (hits[0] === b) n += 4;
  if (hits[hits.length - 1] === s.length - 1) n += 2;   // through the end: the extension
  return n - (hits[hits.length - 1] - hits[0]) * 0.05 - s.length * 0.02;
}

/** Subsequence of q in s with its first char at `start`, else null. */
function forward(q, s, start) {
  const hits = [start];
  for (let k = 1, at = start + 1; k < q.length; k++) {
    const i = s.indexOf(q[k], at);
    if (i < 0) return null;
    hits.push(i);
    at = i + 1;
  }
  return hits;
}

/** Subsequence of q in s with its first char at `start` and the rest as late as possible. */
function late(q, s, start) {
  const hits = new Array(q.length);
  hits[0] = start;
  for (let k = q.length - 1, at = s.length - 1; k > 0; k--) {
    const i = s.lastIndexOf(q[k], at);
    if (i <= start) return null;
    hits[k] = i;
    at = i - 1;
  }
  return hits;
}

/** Subsequence of q in s from `from`, tightened backwards to its shortest window. */
function tight(q, s, from) {
  const first = s.indexOf(q[0], from), hits = first < 0 ? null : forward(q, s, first);
  if (!hits) return null;
  let at = hits[hits.length - 1];
  for (let k = q.length - 1; k >= 0; k--) {
    const i = s.lastIndexOf(q[k], at);
    if (i < from) break;
    hits[k] = i;
    at = i - 1;
  }
  return hits;
}

const range = (i, n) => Array.from({ length: n }, (_, k) => i + k);

/** Best match of q (lowered, no spaces) in path s: { score, hits } or null. */
export function fuzzy(q, s, b) {
  if (!q) return null;
  const candidates = [];
  const sub = s.lastIndexOf(q);
  if (sub >= 0) candidates.push(range(sub, q.length));
  const inBase = s.indexOf(q, b);
  if (inBase >= 0 && inBase !== sub) candidates.push(range(inBase, q.length));
  // Subsequences from the first few starts in the basename, else anywhere in the path.
  for (let i = s.indexOf(q[0], b), n = 0; i >= 0 && n < 8; i = s.indexOf(q[0], i + 1), n++) {
    const h = forward(q, s, i);
    if (!h) break;
    candidates.push(h);
    const l = q.length > 1 ? late(q, s, i) : null;
    if (l) candidates.push(l);
  }
  const t = tight(q, s, b) ?? (candidates.length ? null : tight(q, s, 0));
  if (t) candidates.push(t);
  let best = null;
  for (const hits of candidates) {
    const n = score(s, b, hits);
    if (!best || n > best.score) best = { score: n, hits };
  }
  return best;
}

/**
 * Ranks `files` for `query`. `pool`: indices to look in (a previous query's matches, when
 * this one extends it). -> { results: [{ path, hits }], pool, total }
 */
export function rank(files, query, pool = null) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { results: [], pool: null, total: 0 };
  const found = [];
  const look = pool ?? files.paths.keys();
  for (const i of look) {
    const m = fuzzy(q, files.lower[i], files.base[i]);
    if (m) found.push({ i, score: m.score, hits: m.hits });
  }
  found.sort((a, b) => b.score - a.score || files.paths[a.i].length - files.paths[b.i].length || (files.paths[a.i] < files.paths[b.i] ? -1 : 1));
  return {
    results: found.slice(0, MAX_RESULTS).map((f) => ({ path: files.paths[f.i], hits: f.hits })),
    pool: found.map((f) => f.i).sort((a, b) => a - b),
    total: found.length,
  };
}

/** Occurrences of q (lowered) in text: [{ line, n }] by line (from 0), and the total. */
export function occurrences(text, q) {
  const out = [];
  if (!q) return { lines: out, total: 0 };
  const s = text.toLowerCase();
  let total = 0, line = 0, pos = 0;
  for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + q.length)) {
    for (let k = s.indexOf("\n", pos); k >= 0 && k < i; k = s.indexOf("\n", pos)) { line++; pos = k + 1; }
    total++;
    const last = out[out.length - 1];
    if (last && last.line === line) last.n++;
    else out.push({ line, n: 1 });
  }
  return { lines: out, total };
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** ATX headings of the prose blocks: [{ line (from 1), text }], in order. */
export function headings(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.kind !== "md" || !b.start) continue;
    b.text.split("\n").forEach((l, k) => {
      const m = HEADING.exec(l);
      if (m && m[2]) out.push({ line: b.start + k, text: m[2].replace(/[`*_]/g, "") });
    });
  }
  return out;
}

/** The heading a line sits under, or null. */
export function section(heads, line) {
  let h = null;
  for (const x of heads) { if (x.line > line) break; h = x; }
  return h;
}
