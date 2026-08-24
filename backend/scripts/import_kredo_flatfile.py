#!/usr/bin/env python3
"""
Re-import Kredo flatfile from customer-provided Excel into
`/app/backend/vehicle_specs_kredo.json`.

Compared to the previous conversion this preserves the M&M code (`MMCode`)
per variant so we can display it on the vehicle detail Market Values card
without hitting Kredo again.

Rules:
- Include ALL makes / models / derivatives Kredo publishes. Older data
  (RegYear more than 9 years before today) is skipped so the picker
  isn't flooded with obsolete vintage entries — the exact cut-off is
  set by ``MIN_YEAR`` below.
- Only KEEP passenger-car body types (VehicleType ``A``) and light
  commercial / bakkie body types (VehicleType ``B`` — e.g. Hilux S/C
  and D/C). Everything else Kredo publishes (heavy trucks ``H``,
  buses ``Z``, motorbikes ``C``, tractors ``M``, trailers ``T``,
  caravans ``S``) is skipped because TradeAPP does not appraise them.
- Make is stored title-cased for display friendliness (`Land Rover`,
  `Mercedes-Benz`, `Volkswagen`); a small alias table below preserves
  known industry-uppercase brands like `BMW`, `MINI`. Model + derivative
  stay in Kredo's original UPPERCASE + year-ranged / model-prefixed form
  so the Kredo Vehicle Values resolver can pass them straight through.
- Where the Excel has duplicate rows for the same (make, model, variant,
  year) but different `PublicationSection` (Kredo's pricing publication
  code — 'P'assenger, 'B'ase, 'N', 'Q'...), we keep the FIRST row
  encountered. This preserves whatever the previous conversion happened
  to pick, so referenced M&M codes and new-list prices are deterministic.
- Skip rows with missing/empty make/model/variant/year.
"""
import json
import sys
from datetime import date
from pathlib import Path

import openpyxl

INPUT = Path("/app/backend/kredo_flatfile_202607.xlsx")
OUTPUT = Path("/app/backend/vehicle_specs_kredo.json")

# Skip anything older than this many years — keeps the picker useful
# and drops obsolete entries dealers rarely appraise.
# Aug 2026: bumped from 9 → 10 per product request so the app accepts
# vehicles from 2016 onwards (previously 2017+).
MAX_AGE_YEARS = 10
MIN_YEAR = date.today().year - MAX_AGE_YEARS

# Kredo VehicleType codes we accept:
#   A = automobile (passenger car)
#   B = bakkie / light commercial (Hilux, Ranger, etc.)
# Everything else (H heavy trucks, Z buses, M tractors, C motorbikes,
# T trailers, S specialty like caravans) is skipped.
ALLOWED_VEHICLE_TYPES = {"A", "B"}

# Brands that are conventionally rendered all-uppercase (industry style
# rather than sentence case). Everything else is title-cased for display.
UPPERCASE_MAKES = {
    "BMW", "MINI", "GMC", "MG", "TVR", "SEAT", "SMART", "GAC",
    "JAC", "BAIC", "BYD", "GWM", "FAW", "HAVAL", "DFSK", "JMC",
    "KTM", "SAIC", "LDV", "CMC", "CAM", "BAW", "SRM", "AC",
    "AIM", "IVECO", "HAFEI", "FAW",
}

# Manual overrides where auto-titlecasing gets the branding wrong.
MAKE_DISPLAY_OVERRIDES = {
    "ROLLS ROYCE": "Rolls-Royce",
    "ROLLS-ROYCE": "Rolls-Royce",
    "MERCEDES-BENZ": "Mercedes-Benz",
    "MERCEDES BENZ": "Mercedes-Benz",
    "LAND ROVER": "Land Rover",
    "LAND-ROVER": "Land Rover",
    "ALFA ROMEO": "Alfa Romeo",
    "ASTON MARTIN": "Aston Martin",
    "GAC MOTOR": "GAC Motor",
    "US TRUCK": "US Truck",
    "ZX AUTO": "ZX Auto",
    "GOLDEN JOURNEY": "Golden Journey",
    "GOLDEN DRAGON": "Golden Dragon",
    "ASHOK LEYLAND": "Ashok Leyland",
    "BRANDT BRV": "Brandt BRV",
    "B.A.W": "BAW",
    "C.A.M": "CAM",
}


def _display_make(m: str) -> str:
    m_upper = m.upper().strip()
    if m_upper in MAKE_DISPLAY_OVERRIDES:
        return MAKE_DISPLAY_OVERRIDES[m_upper]
    if m_upper in UPPERCASE_MAKES:
        return m_upper
    # Title-case word-by-word, preserving hyphens.
    return " ".join(
        "-".join(x.capitalize() for x in w.split("-"))
        for w in m_upper.split()
    )


def convert_workbook_to_specs(wb) -> tuple[list[dict], dict]:
    """Turn an already-opened openpyxl workbook into the flat
    JSON structure the app expects.

    Returns (rows, stats) where `stats` is a dict of counters for
    diagnostics. Never touches disk — the caller decides where to
    write the output. This is the reusable core used by both the
    local script (below) and the admin-cockpit uploader endpoint
    that Emergent operators can trigger to refresh the flat-file
    without a code deploy.
    """
    ws = wb["Final"]
    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter)
    idx = {h: i for i, h in enumerate(header)}

    required = [
        "Make", "Model", "Variant", "RegYear", "MMCode", "NewListPrice",
        "FuelType", "ManualAuto", "BodyType", "NoOfDoors", "Drive",
        "Seats", "CubicCapacity", "Kilowatts", "NoCylinders", "VehicleType",
    ]
    missing = [k for k in required if k not in idx]
    if missing:
        raise ValueError(f"Missing headers: {missing}")

    out: list[dict] = []
    seen: set[tuple[str, str, str, int]] = set()
    total = 0
    kept = 0
    skipped_vehicle_type = 0
    skipped_old = 0
    skipped_dupes = 0

    for r in rows_iter:
        total += 1
        make = str(r[idx["Make"]] or "").strip()
        if not make:
            continue
        vtype = str(r[idx["VehicleType"]] or "").strip().upper()
        if vtype not in ALLOWED_VEHICLE_TYPES:
            skipped_vehicle_type += 1
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
        if year < MIN_YEAR:
            skipped_old += 1
            continue

        key = (make.upper(), model, variant, year)
        if key in seen:
            skipped_dupes += 1
            continue
        seen.add(key)

        trans_raw = r[idx["ManualAuto"]]
        trans = None
        if isinstance(trans_raw, str):
            trans = {"M": "Manual", "A": "Automatic"}.get(trans_raw.strip().upper()) or trans_raw

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
            "make": _display_make(make.upper()),
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
            "mm_code": mm_code_str,
        }
        out.append(entry)
        kept += 1

    stats = {
        "total_rows_scanned": total,
        "kept_variants": kept,
        "skipped_vehicle_type": skipped_vehicle_type,
        "skipped_older_than_min_year": skipped_old,
        "skipped_duplicate_variants": skipped_dupes,
        "min_year": MIN_YEAR,
    }
    return out, stats


def main() -> int:
    if not INPUT.exists():
        print(f"input not found: {INPUT}")
        return 1

    wb = openpyxl.load_workbook(str(INPUT), read_only=True)
    try:
        out, stats = convert_workbook_to_specs(wb)
    except ValueError as e:
        print("MISSING HEADERS:", e)
        return 2

    OUTPUT.write_text(json.dumps(out, ensure_ascii=False))
    print(f"scanned rows: {stats['total_rows_scanned']}")
    print(f"kept variants: {stats['kept_variants']}")
    from collections import Counter
    counts = Counter(e["make"] for e in out)
    for m, c in counts.most_common():
        print(f"  {m}: {c}")
    print(f"wrote: {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
