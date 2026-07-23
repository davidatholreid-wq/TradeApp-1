"""Codemod — replace direct `TouchableOpacity` / `Pressable` imports from
`react-native` with our haptic-enabled wrappers, so every tap in the app
plays a light haptic tick without touching any JSX.

Idempotent: safe to re-run. It:
  1. Finds each `import { ... } from "react-native"` block.
  2. Removes `TouchableOpacity` and/or `Pressable` identifiers from it.
  3. If the block ends up empty, deletes it entirely.
  4. Appends `import { TouchableOpacity, Pressable } from "@/src/components/HapticButtons"`
     immediately after the react-native import (or at the top of the
     imports region if none) — only for the identifiers we actually
     removed, and only if that import isn't already present.

Usage (from /app):
    python frontend/src/utils/haptic_codemod.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

FRONTEND = Path(__file__).resolve().parent.parent.parent  # /app/frontend
TARGET_DIRS = [FRONTEND / "app", FRONTEND / "src"]
HAPTIC_IMPORT_PATH = "@/src/components/HapticButtons"

# Files we intentionally leave alone.
SKIP = {
    (FRONTEND / "src" / "components" / "HapticButtons.tsx").resolve(),
    (FRONTEND / "src" / "utils" / "haptics.ts").resolve(),
}

# Matches:  import  {  A , B , TouchableOpacity ,  C  } from "react-native";
RN_IMPORT_RE = re.compile(
    r'import\s*\{\s*([^{}]+?)\s*\}\s*from\s*[\'"]react-native[\'"]\s*;?',
    re.MULTILINE,
)

# Ends of an existing haptic-buttons import (any subset):
HAPTIC_IMPORT_ANY_RE = re.compile(
    r'import\s*\{[^}]*\}\s*from\s*[\'"]' + re.escape(HAPTIC_IMPORT_PATH) + r'[\'"]\s*;?',
)


def process(text: str) -> tuple[str, bool]:
    changed = False
    removed: set[str] = set()

    def replace_rn(match: re.Match) -> str:
        nonlocal changed
        identifiers = [i.strip() for i in match.group(1).split(",") if i.strip()]
        kept = []
        for ident in identifiers:
            # Strip trailing type annotations like `Type as MyType` — we
            # only care about the bare identifier for matching.
            bare = ident.split(" as ")[0].strip()
            if bare in ("TouchableOpacity", "Pressable"):
                removed.add(bare)
                changed = True
                continue
            kept.append(ident)
        if not kept:
            return ""  # Deletes the whole import line.
        return f'import {{ {", ".join(kept)} }} from "react-native";'

    new_text = RN_IMPORT_RE.sub(replace_rn, text)

    if not removed:
        return new_text, False

    # Check whether the target haptic import already exists. If yes, we
    # need to make sure the identifiers we removed are included.
    existing = HAPTIC_IMPORT_ANY_RE.search(new_text)
    want = sorted(removed)
    haptic_line = f'import {{ {", ".join(want)} }} from "{HAPTIC_IMPORT_PATH}";'

    if existing:
        # Merge — extract the existing set, union with `want`, replace.
        current = re.search(r"\{([^}]*)\}", existing.group(0)).group(1)
        current_ids = {i.strip() for i in current.split(",") if i.strip()}
        merged = sorted(current_ids | set(want))
        merged_line = f'import {{ {", ".join(merged)} }} from "{HAPTIC_IMPORT_PATH}";'
        new_text = new_text.replace(existing.group(0), merged_line)
    else:
        # Insert after the (now-possibly-empty) react-native import location
        # by finding the last top-level import line and injecting after it.
        # Simplest: put it at the top of the file after any leading comment
        # block; safest: append after the first import in the file.
        first_import = re.search(r"^import\s.+?;\s*$", new_text, re.MULTILINE)
        if first_import:
            end = first_import.end()
            new_text = new_text[:end] + "\n" + haptic_line + new_text[end:]
        else:
            new_text = haptic_line + "\n" + new_text

    # Squash any empty lines left from a deleted import.
    new_text = re.sub(r"\n{3,}", "\n\n", new_text)

    return new_text, True


def main() -> None:
    scanned = 0
    updated: list[Path] = []
    for base in TARGET_DIRS:
        for p in base.rglob("*.tsx"):
            if p.resolve() in SKIP:
                continue
            scanned += 1
            original = p.read_text()
            new_text, changed = process(original)
            if changed:
                p.write_text(new_text)
                updated.append(p.relative_to(FRONTEND))

    print(f"Scanned {scanned} .tsx files.")
    print(f"Updated {len(updated)} files:")
    for u in updated:
        print(f"  - {u}")


if __name__ == "__main__":
    main()
