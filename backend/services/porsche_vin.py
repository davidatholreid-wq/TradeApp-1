"""Porsche VIN Decoder — pure rule-based, no external API required.

Ported from the public logic surfaced by 911uk.com's client-side VIN
decoder and cross-checked against Porsche's own VIN-position tables.
Everything here is a static lookup against the 17-character VIN — no
network calls, no third-party keys, no per-lookup vendor cost — so
Fourbuy can price this at a flat internal margin (currently R20) and
still deliver an instant response.

VIN structure recap (Porsche, 1981 onwards)
-------------------------------------------
Positions are 1-indexed as they appear in the printed VIN.

    1  Country                W = Germany
    2  Manufacturer           P = Porsche
    3  Vehicle class          0 = sports/passenger, 1 = SUV/MPV
    4-6 ROW filler / NA info  ZZZ on Europe & Rest of World cars;
                              on USA/Canada VINs 4=body, 5=engine,
                              6=restraint
    7   ROW model-code-hi / NA era identifier
    8   Model code middle character
    9   ROW filler (Z) / NA check digit
    10  Model year code       B-9 or A-X on the 2010+ cycle
    11  Factory                S/N/U/L/K/D
    12  Model code low character
    13-17 Serial sequence

Model / type code
-----------------
Two different combining rules apply:

    * ROW VINs → concatenate positions 7 + 8 + 12  (three characters)
    * NA VINs  → concatenate positions 8 + 12       (two characters)

Historical codes are supported alongside every modern Porsche family
(911, 718, Panamera, Cayenne, Macan, Taycan).

Public entry point:
    ``decode_porsche_vin(vin)`` → dict with structured fields.

The returned dict is stable across VINs — every field is always
present so the PDF renderer can rely on the shape.
"""

from __future__ import annotations

import re
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Static lookup tables
# ---------------------------------------------------------------------------

# Model-year code → year. Two 30-year cycles: 1981-2009 then 2010-2039.
# The letters I, O, Q, U and Z are never used.
_MODEL_YEAR_CYCLE_1: dict[str, int] = {
    "B": 1981, "C": 1982, "D": 1983, "E": 1984, "F": 1985, "G": 1986,
    "H": 1987, "J": 1988, "K": 1989, "L": 1990, "M": 1991, "N": 1992,
    "P": 1993, "R": 1994, "S": 1995, "T": 1996, "V": 1997, "W": 1998,
    "X": 1999, "Y": 2000,
    "1": 2001, "2": 2002, "3": 2003, "4": 2004, "5": 2005,
    "6": 2006, "7": 2007, "8": 2008, "9": 2009,
}
_MODEL_YEAR_CYCLE_2: dict[str, int] = {
    "A": 2010, "B": 2011, "C": 2012, "D": 2013, "E": 2014, "F": 2015,
    "G": 2016, "H": 2017, "J": 2018, "K": 2019, "L": 2020, "M": 2021,
    "N": 2022, "P": 2023, "R": 2024, "S": 2025, "T": 2026, "V": 2027,
    "W": 2028, "X": 2029, "Y": 2030,
    "1": 2031, "2": 2032, "3": 2033, "4": 2034, "5": 2035,
    "6": 2036, "7": 2037, "8": 2038, "9": 2039,
}

# Factory code → plant. Codes are stable across Porsche's modern range.
_FACTORY_CODES: dict[str, str] = {
    "S": "Stuttgart-Zuffenhausen, Germany",
    "N": "Neckarsulm, Germany",
    "U": "Uusikaupunki (Valmet), Finland",
    "L": "Leipzig, Germany",
    "K": "Osnabruck (Karmann), Germany",
    "D": "Bratislava, Slovakia",
}

# Country of origin — Porsche only assembles in Germany, Finland and
# Slovakia today, but the VIN also encodes the manufacturer's assigned
# WMI country prefix (always W = Germany for Porsche AG).
_COUNTRY_CODES: dict[str, str] = {
    "W": "Germany",
}

# Vehicle-class digit (position 3).
_VEHICLE_CLASS: dict[str, str] = {
    "0": "Sports / passenger car",
    "1": "SUV / multi-purpose vehicle",
}

# Model / type table. Keys are Porsche's internal type codes as they
# appear when you concatenate the model-code positions (see docstring
# above). Values are the human-readable model name plus generation /
# body notes.
_MODEL_CODES: dict[str, dict[str, str]] = {
    # 911 lineage (Zuffenhausen sports cars)
    "911": {"name": "Porsche 911", "generation": "Original/G-series (pre-964)"},
    "964": {"name": "Porsche 911 (964)", "generation": "964 — 1989-1994"},
    "965": {"name": "Porsche 911 (964) Turbo", "generation": "964 Turbo"},
    "993": {"name": "Porsche 911 (993)", "generation": "993 — 1994-1998 (last air-cooled)"},
    "996": {"name": "Porsche 911 (996)", "generation": "996 — 1998-2005"},
    "997": {"name": "Porsche 911 (997)", "generation": "997 — 2005-2012"},
    "991": {"name": "Porsche 911 (991)", "generation": "991 — 2012-2019"},
    "992": {"name": "Porsche 911 (992)", "generation": "992 — 2019-present"},
    # 911-derivative front-engine, transaxle & mid-engine sports cars
    "930": {"name": "Porsche 911 Turbo (930)", "generation": "930 Turbo — 1975-1989"},
    "924": {"name": "Porsche 924", "generation": "924 — 1976-1988"},
    "931": {"name": "Porsche 924 Turbo", "generation": "924 Turbo"},
    "944": {"name": "Porsche 944", "generation": "944 — 1982-1991"},
    "951": {"name": "Porsche 944 Turbo", "generation": "944 Turbo"},
    "968": {"name": "Porsche 968", "generation": "968 — 1991-1995"},
    "928": {"name": "Porsche 928", "generation": "928 — 1977-1995"},
    # Boxster / Cayman families
    "986": {"name": "Porsche Boxster (986)", "generation": "986 — 1996-2004"},
    "987": {"name": "Porsche Boxster / Cayman (987)", "generation": "987 — 2004-2012"},
    "981": {"name": "Porsche Boxster / Cayman (981)", "generation": "981 — 2012-2016"},
    "982": {"name": "Porsche 718 Boxster / Cayman", "generation": "982 (718) — 2016-present"},
    # Panamera
    "970": {"name": "Porsche Panamera (970)", "generation": "970 — 2009-2016"},
    "971": {"name": "Porsche Panamera (971)", "generation": "971 — 2016-present"},
    # Cayenne (SUVs live under position-3 = 1)
    "9PA": {"name": "Porsche Cayenne (955/957)", "generation": "9PA — 2002-2010"},
    "92A": {"name": "Porsche Cayenne (958)", "generation": "92A — 2010-2018"},
    "9YA": {"name": "Porsche Cayenne (E3)", "generation": "9YA — 2018-present"},
    "9YB": {"name": "Porsche Cayenne Coupe (E3)", "generation": "9YB — 2019-present"},
    # Macan
    "95B": {"name": "Porsche Macan", "generation": "95B — 2014-2024"},
    "95C": {"name": "Porsche Macan Electric", "generation": "95C — 2024-present"},
    # Taycan
    "Y1A": {"name": "Porsche Taycan Sedan", "generation": "J1 — 2019-present"},
    "Y1B": {"name": "Porsche Taycan Cross Turismo", "generation": "J1 — 2020-present"},
    "Y1C": {"name": "Porsche Taycan Sport Turismo", "generation": "J1 — 2022-present"},
    # Carrera GT / 918 halo cars
    "980": {"name": "Porsche Carrera GT", "generation": "980 — 2003-2007"},
    "918": {"name": "Porsche 918 Spyder", "generation": "918 — 2013-2015"},
    # North American VIN two-character model codes (positions 8+12 only).
    # Codes overlap conceptually with the ROW three-char variants above
    # but are decoded from a different structure so we keep them
    # separate. Only the common modern families are supported — a
    # dealer submitting a NA-market VIN on a South African forecourt
    # is rare, but the decode should still be helpful.
    "96": {"name": "Porsche 911 (996)", "generation": "996 — 1998-2005 (US model code)"},
    "97": {"name": "Porsche 911 (997)", "generation": "997 — 2005-2012 (US model code)"},
    "98": {"name": "Porsche 911 (991/992)", "generation": "991/992 — US model code"},
    "99": {"name": "Porsche Boxster / Cayman (986/987)", "generation": "986/987 — US model code"},
    "92": {"name": "Porsche transaxle car (924/944/968)", "generation": "924/944/968 — US model code"},
    "PA": {"name": "Porsche Cayenne (955/957)", "generation": "9PA — US model code"},
    "AA": {"name": "Porsche Cayenne (958)", "generation": "92A — US model code"},
    "YA": {"name": "Porsche Cayenne (E3)", "generation": "9YA — US model code"},
    "YB": {"name": "Porsche Cayenne Coupe (E3)", "generation": "9YB — US model code"},
    "BB": {"name": "Porsche Macan", "generation": "95B — US model code"},
    "1A": {"name": "Porsche Taycan Sedan", "generation": "J1 — US model code"},
    "1B": {"name": "Porsche Taycan Cross Turismo", "generation": "J1 — US model code"},
}


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

_VALID_VIN_CHARS = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")
# North-American VIN check-digit weights (position 1..17) — position 9
# is the check digit itself and is skipped when computing the sum.
_ND_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]
_ND_TRANSLIT: dict[str, int] = {
    **{str(d): d for d in range(10)},
    "A": 1, "B": 2, "C": 3, "D": 4, "E": 5, "F": 6, "G": 7, "H": 8,
    "J": 1, "K": 2, "L": 3, "M": 4, "N": 5, "P": 7, "R": 9,
    "S": 2, "T": 3, "U": 4, "V": 5, "W": 6, "X": 7, "Y": 8, "Z": 9,
}


def _compute_check_digit(vin: str) -> Optional[str]:
    """Compute the North American VIN check digit for position 9.

    Returns None if any character cannot be transliterated (which
    means the VIN isn't a valid North American VIN in the first
    place).
    """
    total = 0
    for i, ch in enumerate(vin):
        v = _ND_TRANSLIT.get(ch)
        if v is None:
            return None
        total += v * _ND_WEIGHTS[i]
    r = total % 11
    return "X" if r == 10 else str(r)


def _is_porsche_wmi(vin: str) -> bool:
    """A modern Porsche VIN always starts with WP0 (sports car) or WP1
    (SUV). We accept the common typo of the letter O for the digit 0
    at position 3 and rewrite it — anything else is rejected.
    """
    return vin[:2] == "WP" and vin[2] in ("0", "1")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def decode_porsche_vin(vin: str) -> dict[str, Any]:
    """Decode a 17-character Porsche VIN.

    Always returns a dict with a ``status`` field so callers can
    branch on success vs. failure without needing exception handling.

    On success (``status == "ok"``) the dict includes:

    ============================== ======================================
    Key                            Meaning
    ============================== ======================================
    vin                            Cleaned upper-case VIN.
    country                        Human-readable manufacturer country.
    manufacturer                   Always "Porsche" on success.
    vehicle_class                  "Sports / passenger car" or "SUV / MPV".
    market                         "Europe / Rest of World" or "USA / Canada".
    model_code                     Type code as it appears (e.g. "9YA").
    model                          Model name (e.g. "Porsche Cayenne (E3)").
    generation                     Generation label (e.g. "9YA — 2018-...").
    model_year                     Integer year (e.g. 2023).
    model_year_ambiguous           True if the code repeats and we picked
                                   the most plausible cycle for this
                                   model.
    factory_code                   Single-letter factory code.
    factory                        Human-readable plant.
    serial                         Positions 13-17.
    serial_masked                  Positions 13-17 as "*****" for safe
                                   sharing.
    check_digit                    Position 9 as printed (NA only).
    check_digit_computed           Expected check digit (NA only).
    check_digit_valid              Boolean or None if not applicable.
    positions                      Dict of every VIN position for the
                                   PDF renderer.
    warnings                       List of soft warnings (non-fatal).
    ============================== ======================================

    On failure (``status == "error"``) only ``status`` and ``error``
    are guaranteed.
    """
    raw = (vin or "").strip().upper()
    # Users occasionally paste "WPO..." instead of "WP0..." — the
    # letter O is disallowed by the modern VIN standard so we quietly
    # rewrite it in the third position where Porsche always uses 0.
    if raw.startswith("WPO"):
        raw = "WP0" + raw[3:]

    if not _VALID_VIN_CHARS.match(raw):
        return {
            "status": "error",
            "error": "VIN must be exactly 17 characters (A-Z 0-9, no I/O/Q).",
        }
    if not _is_porsche_wmi(raw):
        return {
            "status": "error",
            "error": "Not a Porsche VIN. Modern Porsches begin with WP0 (sports car) or WP1 (SUV).",
        }

    warnings: list[str] = []
    # Character breakdown
    p1 = raw[0]
    p2 = raw[1]
    p3 = raw[2]
    p4, p5, p6 = raw[3], raw[4], raw[5]
    p7 = raw[6]
    p8 = raw[7]
    p9 = raw[8]
    p10 = raw[9]
    p11 = raw[10]
    p12 = raw[11]
    serial = raw[12:]

    # Market detection — the ZZZ filler at positions 4-6 is the ROW
    # signature. USA/Canada VINs use those positions for body / engine
    # / restraint codes.
    is_row = (p4, p5, p6) == ("Z", "Z", "Z")
    market = "Europe / Rest of World" if is_row else "USA / Canada"

    # Model / type code
    if is_row:
        model_code = f"{p7}{p8}{p12}"
    else:
        model_code = f"{p8}{p12}"
    model_lookup = _MODEL_CODES.get(model_code) or _MODEL_CODES.get(model_code.upper()) or {}
    if not model_lookup:
        warnings.append(
            f"Model code '{model_code}' not in the reference table. "
            "This may be a very new derivative or a market-specific variant."
        )

    # Model-year decoding. The character repeats in a 30-year cycle so
    # we use the model family (or, for NA VINs, position 7's era
    # identifier where "9" = pre-2010 and "A" = 2010+) to pick the
    # most plausible cycle. Fall back to cycle 2 for any modern model.
    year = None
    ambiguous = False
    cycle1_year = _MODEL_YEAR_CYCLE_1.get(p10)
    cycle2_year = _MODEL_YEAR_CYCLE_2.get(p10)
    modern_families = {
        "991", "992", "982", "981", "970", "971", "92A", "9YA", "9YB",
        "95B", "95C", "Y1A", "Y1B", "Y1C",
        # NA equivalents
        "98", "AA", "YA", "YB", "BB", "1A", "1B",
    }
    older_families = {
        "911", "930", "924", "931", "944", "951", "968", "928",
        "986", "987", "996", "997", "964", "993", "9PA", "980", "965",
        # NA equivalents
        "96", "97", "99", "92", "PA",
    }
    # NA-era override — trust position 7 when it looks definitive.
    if not is_row:
        if p7 == "A" and cycle2_year is not None:
            year = cycle2_year
        elif p7 == "9" and cycle1_year is not None:
            year = cycle1_year
    if year is None:
        if model_code in modern_families and cycle2_year is not None:
            year = cycle2_year
        elif model_code in older_families and cycle1_year is not None:
            year = cycle1_year
        elif cycle2_year is not None:
            # Unknown model — bias to the modern cycle since the vast
            # majority of dealer-submitted VINs are contemporary cars.
            year = cycle2_year
            if cycle1_year is not None:
                ambiguous = True
                warnings.append(
                    f"Model-year code '{p10}' also matched {cycle1_year} in the earlier cycle."
                )
        elif cycle1_year is not None:
            year = cycle1_year
        else:
            warnings.append(f"Model-year code '{p10}' is not a valid Porsche year designator.")

    # Factory
    factory = _FACTORY_CODES.get(p11)
    if not factory:
        warnings.append(f"Factory code '{p11}' is not one of Porsche's known plants.")

    # NA check digit
    check_computed = None
    check_valid = None
    if not is_row:
        check_computed = _compute_check_digit(raw)
        if check_computed is not None:
            check_valid = check_computed == p9
            if not check_valid:
                warnings.append(
                    "North American check digit does not match — verify the VIN was transcribed correctly. "
                    "A wrong check digit doesn't automatically mean the car isn't genuine, but it is "
                    "a common transcription-error indicator."
                )

    return {
        "status": "ok",
        "vin": raw,
        "country": _COUNTRY_CODES.get(p1, "Unknown"),
        "manufacturer": "Porsche",
        "vehicle_class": _VEHICLE_CLASS.get(p3, "Unknown"),
        "market": market,
        "model_code": model_code,
        "model": model_lookup.get("name") or f"Porsche (code {model_code})",
        "generation": model_lookup.get("generation") or "",
        "model_year": year,
        "model_year_ambiguous": ambiguous,
        "factory_code": p11,
        "factory": factory or f"Unknown ({p11})",
        "serial": serial,
        "serial_masked": "*" * len(serial),
        "check_digit": p9 if not is_row else None,
        "check_digit_computed": check_computed,
        "check_digit_valid": check_valid,
        "positions": {
            "1": p1, "2": p2, "3": p3,
            "4": p4, "5": p5, "6": p6,
            "7": p7, "8": p8, "9": p9,
            "10": p10, "11": p11, "12": p12,
            "13-17": serial,
        },
        "warnings": warnings,
        "disclaimer": (
            "VIN decoding identifies the model, model year, factory and "
            "production sequence. It is not a complete factory build "
            "specification — for the full original equipment list, use "
            "the option label, service book, invoice or a Porsche "
            "Certificate of Authenticity."
        ),
    }


def is_porsche_supported_make(make: Any) -> bool:
    """Return True if the given make string is a Porsche family label.
    Case-insensitive; trims and normalises whitespace.
    """
    if not make:
        return False
    return str(make).strip().upper() == "PORSCHE"
