// sample.js — JavaScript highlighting fixture
import { readFile } from "node:fs/promises";

const LIMIT = 1_000_000;

export async function preview(path, { on = null } = {}) {
  const text = await readFile(path, "utf8");
  if (text.includes("\0")) return { kind: "binary" };
  return text.length > LIMIT ? { kind: "text", text: text.slice(0, LIMIT), truncated: true } : { kind: "text", text };
}

class Counter {
  #n = 0;
  inc() { return ++this.#n; }
}

console.log(new Counter().inc(), /re[gG]ex/.test("regex"), `template ${42}`);
