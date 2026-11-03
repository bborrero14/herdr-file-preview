"""sample.py — Python highlighting fixture."""
from dataclasses import dataclass
from pathlib import Path

LIMIT = 1_000_000


@dataclass
class Source:
    path: Path
    truncated: bool = False

    def read(self) -> str:
        text = self.path.read_text(encoding="utf-8")
        if len(text) > LIMIT:
            self.truncated = True
            return text[:LIMIT]
        return text


if __name__ == "__main__":
    for p in sorted(Path(".").glob("*.md")):
        print(f"{p.name}: {len(Source(p).read())} chars")  # comment
