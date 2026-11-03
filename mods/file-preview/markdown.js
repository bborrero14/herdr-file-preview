// Splits a Markdown document into prose and fenced code blocks.
// Prose goes to TextView.markdown (GFM is fine there); fences get their own readonly Editor,
// because TextView draws code without colors.

const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
// Very long prose is cut into chunks at blank lines so one TextView never holds a whole 1 MB file.
const CHUNK = 32000;

/** -> [{ kind: "md", text } | { kind: "code", info, text }] */
export function segment(source) {
  const lines = source.split("\n"), out = [];
  let prose = [];
  const flush = () => {
    if (!prose.length) return;
    const text = prose.join("\n");
    prose = [];
    if (!text.trim()) return;
    for (const piece of chunks(text)) out.push({ kind: "md", text: piece });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i]);
    // A backtick fence's info string may not contain backticks (CommonMark).
    if (!m || (m[2][0] === "`" && m[3].includes("`"))) { prose.push(lines[i]); continue; }
    const indent = m[1].length, mark = m[2], info = m[3].trim().split(/\s+/)[0] ?? "";
    const close = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !close.test(lines[j]); j++) body.push(stripIndent(lines[j], indent));
    flush();
    out.push({ kind: "code", info, text: body.join("\n") });
    i = j; // an unclosed fence runs to the end of the document
  }
  flush();
  return out;
}

function stripIndent(line, n) {
  let k = 0;
  while (k < n && line[k] === " ") k++;
  return line.slice(k);
}

function chunks(text) {
  if (text.length <= CHUNK) return [text];
  const out = [];
  let start = 0;
  while (text.length - start > CHUNK) {
    let cut = text.lastIndexOf("\n\n", start + CHUNK);
    if (cut <= start) cut = text.indexOf("\n\n", start + CHUNK);
    if (cut < 0) break;
    out.push(text.slice(start, cut));
    start = cut + 2;
  }
  out.push(text.slice(start));
  return out;
}
