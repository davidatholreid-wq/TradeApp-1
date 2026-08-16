"""Ferrari VIN Decoder — pure rule-based, no external API required.

Same shape as ``services.porsche_vin`` — the public entry point is
``decode_ferrari_vin(vin)`` and returns a stable dict so the PDF
renderer + mobile card can rely on the fields.

VIN structure (Ferrari, 1981+ / 17-character era)
-------------------------------------------------
Ferrari's VIN uses the standard 17-character layout but with a
Ferrari-specific interpretation of the VDS (positions 4-8). The
front section of the VDS can appear in two arrangements depending on
the model era:

    "AA00" format (older cars, roughly Testarossa era)
        4 : Engine displacement / cylinder code
        5 : Safety-system code
        6-7 : Model code (two chars)
        8 : Market code

    "00AA" format (newer cars)
        4-5 : Model code (two chars)
        6   : Engine displacement / cylinder code
        7   : Safety-system code
        8   : Market code

The rest of the layout is the same regardless of era:

    9        Check digit (NA cars) — filler otherwise
    10       Model year code
    11       Assembly plant (0 = Maranello)
    12-17    Sequential production serial

Because the format flips between eras and the two-character model
code alone doesn't disambiguate every derivative, the decoder returns
the model code verbatim alongside the best-known model label. When
a code isn't in the reference table the decoder emits a warning and
still returns the raw positions so the dealer / admin has something
to work with.
"""

from __future__ import annotations

import re
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Static lookup tables
# ---------------------------------------------------------------------------

# Model-year code cycles (same as every other 1980+ VIN — I, O, Q, U, Z
# are never used).
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

# WMI (positions 1-3). Ferrari has used a handful over the decades;
# "ZFF" is the modern one and covers everything from the 1980s Mondial
# / Testarossa onwards.
_WMI: dict[str, str] = {
    "ZFF": "Ferrari S.p.A., Italy",
    # Ferrari used ZFA in older joint-Fiat-group VINs on certain
    # markets before ZFF became universal.
    "ZFA": "Ferrari (older / Fiat-group WMI)",
}

# Assembly plant (position 11). Ferrari builds essentially everything
# at Maranello — the "0" code is by far the most common. Other digits
# are accepted with a warning rather than rejected outright in case
# Ferrari adopts a satellite plant in the future.
_PLANT_CODES: dict[str, str] = {
    "0": "Maranello, Italy",
}

# Market code (position 8). The most consistently documented codes;
# unknown codes surface as a warning without failing the decode.
_MARKET_CODES: dict[str, str] = {
    "A": "United States (49-state)",
    "B": "United States (California)",
    "C": "Canada",
    "S": "Switzerland",
    "0": "Europe / Rest of World",
    "1": "Europe / Rest of World",
    "2": "Europe / Rest of World",
    "3": "Europe / Rest of World",
    "4": "Europe / Rest of World",
    "5": "Europe / Rest of World",
    "6": "Europe / Rest of World",
    "7": "Europe / Rest of World",
    "8": "Europe / Rest of World",
    "9": "Europe / Rest of World",
}

# Model / type table. Keys are the two-character model code that
# appears in the VDS (either positions 4-5 in the "00AA" layout or
# positions 6-7 in the "AA00" layout). Values are the human-readable
# label + generation notes.
_MODEL_CODES: dict[str, dict[str, str]] = {
    # 1980s era
    "33": {"name": "Ferrari 308 GTB / GTS family", "era": "1980s"},
    "44": {"name": "Ferrari Testarossa", "era": "1984-1991"},
    "45": {"name": "Ferrari F40", "era": "1987-1992"},
    "46": {"name": "Ferrari 348", "era": "1989-1995"},
    "48": {"name": "Ferrari 328", "era": "1985-1989"},
    "49": {"name": "Ferrari Mondial", "era": "1980s"},
    # 1990s era
    "50": {"name": "Ferrari F50", "era": "1995-1997"},
    "51": {"name": "Ferrari 512 TR", "era": "1991-1994"},
    "52": {"name": "Ferrari F355", "era": "1994-1999"},
    "53": {"name": "Ferrari F512 M", "era": "1994-1996"},
    "55": {"name": "Ferrari 456", "era": "1992-2003"},
    "56": {"name": "Ferrari 550 Maranello / Barchetta", "era": "1996-2001"},
    "57": {"name": "Ferrari 456 M", "era": "1998-2003"},
    "58": {"name": "Ferrari 360 (Modena / Spider / Challenge Stradale)", "era": "1999-2005"},
    "59": {"name": "Ferrari 575M Maranello / Superamerica", "era": "2002-2006"},
    # 2000s era
    "60": {"name": "Ferrari 550 Barchetta Pininfarina", "era": "2001"},
    "61": {"name": "Ferrari Enzo", "era": "2002-2004"},
    "62": {"name": "Ferrari 612 Scaglietti", "era": "2004-2011"},
    "63": {"name": "Ferrari 599 GTB Fiorano / GTO / SA Aperta", "era": "2006-2012"},
    "64": {"name": "Ferrari F430 (Berlinetta / Spider / Scuderia / 16M)", "era": "2004-2009"},
    "66": {"name": "Ferrari California", "era": "2008-2014"},
    "67": {"name": "Ferrari 458 Italia / Spider", "era": "2009-2015"},
    "68": {"name": "Ferrari FF", "era": "2011-2016"},
    "69": {"name": "Ferrari F12 Berlinetta / tdf", "era": "2012-2017"},
    # 2010s era
    "74": {"name": "Ferrari 458 Speciale / Speciale A", "era": "2013-2015"},
    "75": {"name": "Ferrari 488 GTB / Spider / Pista", "era": "2015-2019"},
    "76": {"name": "Ferrari LaFerrari / Aperta", "era": "2013-2018"},
    "77": {"name": "Ferrari California T", "era": "2014-2017"},
    "78": {"name": "Ferrari GTC4Lusso / GTC4Lusso T", "era": "2016-2020"},
    "79": {"name": "Ferrari 812 Superfast / GTS", "era": "2017-present"},
    # 2020s era
    "81": {"name": "Ferrari Portofino / Portofino M", "era": "2017-present"},
    "82": {"name": "Ferrari 812 Competizione / Competizione A", "era": "2021-2023"},
    "83": {"name": "Ferrari Monza SP1 / SP2", "era": "2018-2020"},
    "84": {"name": "Ferrari SF90 Stradale / Spider / XX", "era": "2019-present"},
    "85": {"name": "Ferrari F8 Tributo / Spider", "era": "2019-2022"},
    "86": {"name": "Ferrari Roma / Roma Spider", "era": "2020-present"},
    "87": {"name": "Ferrari 296 GTB / GTS", "era": "2021-present"},
    "88": {"name": "Ferrari Purosangue", "era": "2022-present"},
    "89": {"name": "Ferrari 12Cilindri / 12Cilindri Spider", "era": "2024-present"},
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
    Returns None if any character cannot be transliterated.
    """
    total = 0
    for i, ch in enumerate(vin):
        v = _ND_TRANSLIT.get(ch)
        if v is None:
            return None
        total += v * _ND_WEIGHTS[i]
    r = total % 11
    return "X" if r == 10 else str(r)


def _is_ferrari_wmi(vin: str) -> bool:
    """Modern Ferrari VINs begin with ZFF; a small number of older
    Fiat-group Ferraris used ZFA.
    """
    return vin[:3] in _WMI


def _extract_model_code(vin: str) -> tuple[str, str, str, str]:
    """Try both known VDS layouts and return
    (model_code, engine_code, safety_code, layout).

    The layout is either "AA00" (older cars: model at positions 6-7)
    or "00AA" (newer cars: model at positions 4-5). We pick whichever
    layout yields a two-character model code that's in the reference
    table; failing that, default to the modern "00AA" layout so newer
    unknown models still surface sensibly.
    """
    p4, p5, p6, p7 = vin[3], vin[4], vin[5], vin[6]

    # Layout A ("00AA" — modern): 4-5 = model, 6 = engine, 7 = safety
    modern_code = f"{p4}{p5}"
    # Layout B ("AA00" — older): 4 = engine, 5 = safety, 6-7 = model
    older_code = f"{p6}{p7}"

    modern_hit = modern_code in _MODEL_CODES
    older_hit = older_code in _MODEL_CODES

    if modern_hit and not older_hit:
        return (modern_code, p6, p7, "00AA (modern)")
    if older_hit and not modern_hit:
        return (older_code, p4, p5, "AA00 (older)")
    if modern_hit and older_hit:
        # Both tables hit — extremely unlikely but disambiguate on the
        # model-year cycle when possible. Modern cycle usually starts
        # at 2010 (A-9); we bias towards modern here.
        return (modern_code, p6, p7, "00AA (modern)")
    # Neither known — default to modern layout so callers still see a
    # sensible position breakdown, and rely on the warning list.
    return (modern_code, p6, p7, "00AA (assumed)")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def decode_ferrari_vin(vin: str) -> dict[str, Any]:
    """Decode a 17-character Ferrari VIN.

    Same contract as ``services.porsche_vin.decode_porsche_vin`` — always
    returns a dict with a ``status`` field so callers can branch on
    success without exception handling.
    """
    raw = (vin or "").strip().upper()
    if not _VALID_VIN_CHARS.match(raw):
        return {
            "status": "error",
            "error": "VIN must be exactly 17 characters (A-Z 0-9, no I/O/Q).",
        }
    if not _is_ferrari_wmi(raw):
        return {
            "status": "error",
            "error": "Not a Ferrari VIN. Modern Ferraris begin with ZFF (a handful of older Fiat-group cars use ZFA).",
        }

    warnings: list[str] = []
    # Positional breakdown
    p1, p2, p3 = raw[0], raw[1], raw[2]
    p4, p5, p6, p7 = raw[3], raw[4], raw[5], raw[6]
    p8 = raw[7]
    p9 = raw[8]
    p10 = raw[9]
    p11 = raw[10]
    serial = raw[11:]

    # Model + engine + safety
    model_code, engine_code, safety_code, layout = _extract_model_code(raw)
    model_meta = _MODEL_CODES.get(model_code, {})
    if not model_meta:
        warnings.append(
            f"Model code '{model_code}' not in the reference table. "
            "This may be a very new derivative, a limited series or a "
            "market-specific variant — the rest of the VIN was still "
            "decoded normally."
        )

    # Market
    market = _MARKET_CODES.get(p8)
    is_na = p8 in ("A", "B", "C")
    if market is None:
        warnings.append(f"Market code '{p8}' is not one of Ferrari's documented codes.")

    # Model-year decoding — Ferrari doesn't publish a strict "modern vs
    # older" split, but any car with a NA market code (A/B/C) is
    # US-market and cars sold new after ~2010 fall on cycle 2 by
    # default. When we know the model era, we prefer whichever cycle
    # overlaps it.
    year: Optional[int] = None
    ambiguous = False
    cycle1_year = _MODEL_YEAR_CYCLE_1.get(p10)
    cycle2_year = _MODEL_YEAR_CYCLE_2.get(p10)
    era = (model_meta.get("era") or "").lower()
    prefers_modern = any(k in era for k in ("2010", "2011", "2012", "2013", "2014", "2015",
                                             "2016", "2017", "2018", "2019", "2020",
                                             "2021", "2022", "2023", "2024", "present"))
    prefers_older = any(k in era for k in ("1980", "1981", "1982", "1983", "1984", "1985",
                                             "1986", "1987", "1988", "1989", "1990",
                                             "1991", "1992", "1993", "1994", "1995",
                                             "1996", "1997", "1998", "1999", "2000",
                                             "2001", "2002", "2003", "2004", "2005",
                                             "2006", "2007", "2008", "2009"))
    if prefers_modern and cycle2_year is not None:
        year = cycle2_year
    elif prefers_older and cycle1_year is not None:
        year = cycle1_year
    elif cycle2_year is not None:
        year = cycle2_year
        if cycle1_year is not None:
            ambiguous = True
            warnings.append(
                f"Model-year code '{p10}' also matched {cycle1_year} in the earlier cycle."
            )
    elif cycle1_year is not None:
        year = cycle1_year
    else:
        warnings.append(f"Model-year code '{p10}' is not a valid Ferrari year designator.")

    # Plant
    plant = _PLANT_CODES.get(p11)
    if not plant:
        warnings.append(
            f"Plant code '{p11}' is not one of Ferrari's documented plants "
            "(the vast majority of Ferraris are built at Maranello, code '0')."
        )

    # NA check digit
    check_computed = None
    check_valid = None
    if is_na:
        check_computed = _compute_check_digit(raw)
        if check_computed is not None:
            check_valid = check_computed == p9
            if not check_valid:
                warnings.append(
                    "North American check digit does not match. Double-check the VIN "
                    "was transcribed correctly — a wrong check digit is the single "
                    "most common transcription-error indicator."
                )

    return {
        "status": "ok",
        "vin": raw,
        "manufacturer": "Ferrari",
        "country": _WMI.get(raw[:3], "Italy"),
        "wmi": raw[:3],
        "model_code": model_code,
        "model": model_meta.get("name") or f"Ferrari (code {model_code})",
        "era": model_meta.get("era") or "",
        "layout": layout,
        "engine_code": engine_code,
        "safety_code": safety_code,
        "market_code": p8,
        "market": market or f"Unknown ({p8})",
        "model_year": year,
        "model_year_ambiguous": ambiguous,
        "plant_code": p11,
        "plant": plant or f"Unknown ({p11})",
        "serial": serial,
        "check_digit": p9 if is_na else None,
        "check_digit_computed": check_computed,
        "check_digit_valid": check_valid,
        "positions": {
            "1": p1, "2": p2, "3": p3,
            "4": p4, "5": p5, "6": p6, "7": p7,
            "8": p8, "9": p9,
            "10": p10, "11": p11,
            "12-17": serial,
        },
        "warnings": warnings,
        "disclaimer": (
            "VIN decoding identifies the model family, model year, plant and "
            "production sequence. Ferrari's VDS structure varies between eras "
            "and doesn't fully disambiguate every derivative — for the "
            "authoritative build specification, refer to the Ferrari "
            "Classiche certification or the original build sheet."
        ),
    }


def is_ferrari_supported_make(make: Any) -> bool:
    """Return True if the given make string is a Ferrari family label."""
    if not make:
        return False
    return str(make).strip().upper() == "FERRARI"
