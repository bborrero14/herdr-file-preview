#!/bin/sh
# Copies the repo's mods/ into Herdr (~/.config/herdr-app/mods/, or $HERDR_APP_HOME/mods/).
# Herdr hot-reloads every copy on save, so run this after each edit (or under `fswatch`).
set -eu
repo="$(cd "$(dirname "$0")/.." && pwd)"
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
# Mods import only from their own folder: the launcher carries a copy of the popup's dock.js.
if ! cmp -s "$repo/mods/file-preview/dock.js" "$repo/mods/file-preview-panel/dock.js"; then
  echo "dock.js differs: cp mods/file-preview/dock.js mods/file-preview-panel/" >&2
  exit 1
fi
for mod in "$repo"/mods/*/; do
  name="$(basename "$mod")"
  # A symlink left from an earlier install would make rsync write through it into the repo.
  [ -L "$dest/$name" ] && rm "$dest/$name"
  # .cache/ (Mermaid renders) and jsconfig.json belong to the installed copy, not the repo.
  rsync -a --delete --exclude .cache/ --exclude jsconfig.json --exclude gpui-kit.d.ts "$mod" "$dest/$name/"
  echo "synced $name -> $dest/$name"
done
