#!/usr/bin/env python3
"""
Re-import Kredo flatfile from customer-provided Excel into
`/app/backend/vehicle_specs_kredo.json`.

Compared to the previous conversion this preserves the M&M code (`MMCode`)
per variant so we can display it on the vehicle detail Market Values card
without hitting Kredo again.

Rules:
- Filter to the four testing makes the user asked for: AUDI, BMW, FORD, TOYOTA.
- Make is stored title-cased for display friendliness (`Audi`, `BMW`, `Ford`,
  `Toyota`). Model + derivative stay in Kredo's original UPPERCASE +
  year-ranged / model-prefixed form so the Kredo Vehicle Values resolver
  can pass them straight through.
- Where the Excel has duplicate rows for the same (make, model, variant,
  year) but different `PublicationSection` (Kredo's pricing publication
  code — 'P'assenger, 'B'ase, 'N', 'Q'...), we keep the FIRST row
  encountered. This preserves whatever the previous conversion happened
  to pick, so referenced M&M codes and new-list prices are deterministic.
- Skip rows with missing/empty make/model/variant/year.
"""
import json
import sys
from pathlib import Path

import openpyxl

INPUT = Path("/tmp/kredo_flatfile.xlsx")
OUTPUT = Path("/app/backend/vehicle_specs_kredo.json")
ALLOWED_MAKES = {"AUDI", "BMW", "FORD", "TOYOTA"}


def _title_make(m: str) -> str:
    # BMW stays uppercase (industry convention); others title-case.
    if m == "BMW":
        return "BMW"
    return m.title()


def main() -> int:
    if not INPUT.exists():
        print(f"input not found: {INPUT}")
        return 1

    wb = openpyxl.load_workbook(str(INPUT), read_only=True)
    ws = wb["Final"]
    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    idx = {h: i for i, h in enumerate(header)}

    required = [
        "Make", "Model", "Variant", "RegYear", "MMCode", "NewListPrice",
        "FuelType", "ManualAuto", "BodyType", "NoOfDoors", "Drive",
        "Seats", "CubicCapacity", "Kilowatts", "NoCylinders",
    ]
    missing = [k for k in required if k not in idx]
    if missing:
        print("MISSING HEADERS:", missing)
        return 2

    out: list[dict] = []
    seen: set[tuple[str, str, str, int]] = set()
    total = 0
    kept = 0

    for r in rows:
        total += 1
        make = str(r[idx["Make"]] or "").strip()
        if make.upper() not in ALLOWED_MAKES:
            continue
        model = str(r[idx["Model"]] or "").strip()
        variant = str(r[idx["Variant"]] or "").strip()
        year_raw = r[idx["RegYear"]]
        if not (model and variant and year_raw):
            continue
        try:
            year = int(year_raw)
        except (TypeError, ValueError):
            continue

        key = (make.upper(), model, variant, year)
        if key in seen:
            continue
        seen.add(key)

        # Normalise transmission "M"/"A" → "Manual"/"Automatic" for display.
        trans_raw = r[idx["ManualAuto"]]
        trans = None
        if isinstance(trans_raw, str):
            trans = {"M": "Manual", "A": "Automatic"}.get(trans_raw.strip().upper()) or trans_raw

        # Fuel type — Kredo uses single letters. Expand common ones.
        fuel_raw = r[idx["FuelType"]]
        fuel = None
        if isinstance(fuel_raw, str):
            fuel = {
                "P": "Petrol", "D": "Diesel", "E": "Electric", "H": "Hybrid", "G": "LPG",
            }.get(fuel_raw.strip().upper()) or fuel_raw

        mm_code = r[idx["MMCode"]]
        try:
            mm_code_str = str(int(mm_code)) if mm_code not in (None, "") else None
        except (TypeError, ValueError):
            mm_code_str = str(mm_code).strip() or None if mm_code else None

        new_price = r[idx["NewListPrice"]]
        try:
            new_price_num = float(new_price) if new_price not in (None, "") else None
        except (TypeError, ValueError):
            new_price_num = None

        entry = {
            "make": _title_make(make.upper()),
            "model": model,
            "derivative": variant,
            "fuel_type": fuel,
            "transmission": trans,
            "year_of_production": year,
            "body_type": r[idx["BodyType"]],
            "doors": r[idx["NoOfDoors"]],
            "drive": r[idx["Drive"]],
            "seats": r[idx["Seats"]],
            "cc": r[idx["CubicCapacity"]],
            "kw": r[idx["Kilowatts"]],
            "cylinders": r[idx["NoCylinders"]],
            "new_list_price_zar": new_price_num,
            # NEW — carried through so the Market Values card can render an
            # M&M code without an extra API call.
            "mm_code": mm_code_str,
        }
        out.append(entry)
        kept += 1

    OUTPUT.write_text(json.dumps(out, ensure_ascii=False))
    print(f"scanned rows: {total}")
    print(f"kept variants: {kept} (unique make/model/variant/year within allowed makes)")
    # Sanity check counts per make.
    from collections import Counter
    counts = Counter(e["make"] for e in out)
    for m, c in counts.most_common():
        print(f"  {m}: {c}")
    print(f"wrote: {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
