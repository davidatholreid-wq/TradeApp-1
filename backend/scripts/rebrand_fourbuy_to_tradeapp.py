#!/usr/bin/env python3
"""One-off rebrand script — Fourbuy → TradeAPP.

Runs a small, ordered set of literal string replacements across all
production TypeScript / Python source files. Ordered from most-specific
to least-specific so shorter replacements don't clobber longer ones.

Skips:
  * node_modules, __pycache__, .git
  * backend/tests/  (test fixtures reference the old brand; not user-visible)
  * backend/scripts/generate_tradeapp_logo.py (this rebrand tool itself)
  * assets (binary PNGs handled separately)

Prefix `FB-` on submission references is intentionally preserved for
existing records — the codebase now emits `TA-` for NEW submissions
elsewhere.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path("/app")
SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".yarn", ".expo", "build", "dist"}
SKIP_FILES = {
    Path("/app/backend/scripts/generate_tradeapp_logo.py"),
    Path("/app/backend/scripts/rebrand_fourbuy_to_tradeapp.py"),
}
INCLUDE_EXTS = {".ts", ".tsx", ".py"}

# Ordered: MOST specific first. Later rules never touch text a prior rule
# already rewrote (they only match remaining "Fourbuy" tokens).
REPLACEMENTS: list[tuple[str, str]] = [
    # Full-name / legal / user-facing multi-token phrases
    ("TRADE AI powered by FOURBUY", "TradeAPP"),
    ("Trade AI powered by Fourbuy", "TradeAPP"),
    ("trade ai powered by fourbuy", "TradeAPP"),
    ("Fourbuy Car Buying Co (Pty) Ltd", "TradeAPP (Pty) Ltd"),
    ("Fourbuy Car Buying Co. (Pty) Ltd", "TradeAPP (Pty) Ltd"),
    ("Fourbuy Car Buying Co.", "TradeAPP"),
    ("Fourbuy Car Buying Co", "TradeAPP"),
    ("FOURBUY CAR BUYING CO.", "TRADEAPP"),
    ("FOURBUY CAR BUYING CO", "TRADEAPP"),

    # Emails / domains
    ("admin@fourbuy.co.za",   "admin@tradeapp.co.za"),
    ("hello@fourbuy.co.za",   "hello@tradeapp.co.za"),
    ("support@fourbuy.co.za", "support@tradeapp.co.za"),
    ("accounts@fourbuy.co.za","accounts@tradeapp.co.za"),
    ("api.fourbuy.co.za",     "api.tradeapp.co.za"),
    ("www.fourbuy.co.za",     "www.tradeapp.co.za"),
    ("fourbuy.co.za",         "tradeapp.co.za"),

    # Domain-specific compound phrases (order matters)
    ("Fourbuy VIN Data API",  "TradeAPP VIN Data API"),
    ("FOURBUY VIN DATA API",  "TRADEAPP VIN DATA API"),
    ("Fourbuy Pricing Agreement", "TradeAPP Pricing Agreement"),
    ("Fourbuy Rewards",       "TradeAPP Rewards"),
    ("Fourbuy Offer",         "TradeAPP Offer"),
    ("Fourbuy Cover",         "TradeAPP Cover"),
    ("Fourbuy admin",         "TradeAPP admin"),
    ("Fourbuy support",       "TradeAPP support"),
    ("Fourbuy accounts",      "TradeAPP accounts"),
    ("Fourbuy dealer",        "TradeAPP dealer"),
    ("Fourbuy premises",      "TradeAPP premises"),
    ("Fourbuy staff",         "TradeAPP staff"),
    ("Fourbuy prices",        "TradeAPP prices"),
    ("Fourbuy priced",        "TradeAPP priced"),
    ("Fourbuy pricing",       "TradeAPP pricing"),
    ("Fourbuy monochrome",    "TradeAPP monochrome"),
    ("Fourbuy account manager", "TradeAPP account manager"),
    ("contact Fourbuy",       "contact TradeAPP"),
    ("Contact Fourbuy",       "Contact TradeAPP"),
    ("Please contact Fourbuy","Please contact TradeAPP"),

    # Generic single-word forms (case-preserved)
    ("FOURBUY", "TRADEAPP"),
    ("Fourbuy", "TradeAPP"),

    # Lowercase — mostly logger names, folder paths in comments,
    # env var doc-strings. Keep the folder path prefix `fourbuy/` in
    # remote object-storage untouched below.
]


def _should_skip(path: Path) -> bool:
    if path in SKIP_FILES:
        return True
    for part in path.parts:
        if part in SKIP_DIRS:
            return True
    # Skip backend tests (fixtures reference the old brand, no user impact).
    if "backend/tests" in str(path):
        return True
    return False


def _rewrite(text: str) -> tuple[str, int]:
    hits = 0
    for old, new in REPLACEMENTS:
        if old in text:
            hits += text.count(old)
            text = text.replace(old, new)
    return text, hits


def main() -> int:
    changed = 0
    scanned = 0
    replacements = 0
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix not in INCLUDE_EXTS:
            continue
        if _should_skip(path):
            continue
        scanned += 1
        try:
            src = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        new, hits = _rewrite(src)
        if hits > 0:
            path.write_text(new, encoding="utf-8")
            changed += 1
            replacements += hits
            print(f"  {path}: {hits} replacements")
    print(f"\nScanned {scanned} files, rewrote {changed} of them, "
          f"{replacements} total replacements.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
