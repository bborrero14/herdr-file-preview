# Mermaid fixture

Prose before the first diagram. Editing this paragraph must not re-render any diagram.

## Flowchart

```mermaid
flowchart LR
  A[Open file] --> B{Markdown?}
  B -- yes --> C[segment]
  B -- no --> D[Editor]
  C --> E[TextView]
  C --> F[Editor per fence]
  C --> G[mmdc → PNG]
```

## Sequence diagram

```mermaid
sequenceDiagram
  participant V as View
  participant Q as Queue
  participant M as mmdc
  V->>Q: request(key)
  Q->>M: -i in.mmd -o out.png
  M-->>Q: code 0
  Q-->>V: done(png, w, h)
```

## Class diagram

```mermaid
classDiagram
  class Mermaid {
    +Map known
    +request(d, waiter, cx)
    +prune()
  }
  class FilePreview {
    +blocks
    +diagrams(cx)
  }
  FilePreview --> Mermaid : one per copy
```

## Broken diagram (fallback with the error)

```mermaid
flowchart TD
  A --> B -->
  ((( broken
```

## Two identical diagrams (one render, two images)

```mermaid
pie title Cache
  "hit" : 80
  "miss" : 20
```

Some prose between the twins.

```mermaid
pie title Cache
  "hit" : 80
  "miss" : 20
```

Prose after the last diagram.
