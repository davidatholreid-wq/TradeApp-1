"""SA ID Number validation.

South African ID numbers are 13 digits: YYMMDD SSSS C A Z where
  YYMMDD — date of birth (2-digit year, 01-12 month, 01-31 day)
  SSSS   — gender / sequence within DoB (0000-4999 female, 5000-9999 male)
  C      — citizenship (0 SA, 1 permanent resident)
  A      — historically 8/9, kept for backwards compatibility
  Z      — Luhn checksum

We enforce all three: exactly 13 digits, a real calendar date in YYMMDD, and
a valid Luhn checksum. `citizenship` and the `A` digit are inspected but not
rejected — some legacy IDs have an `A` other than 8/9.
"""
from __future__ import annotations

from datetime import date
from typing import Tuple


def _luhn_ok(digits: str) -> bool:
    """SA ID uses a variant of the Luhn algorithm — every second digit from
    the RIGHT is doubled, doubled digits > 9 have their digits summed, and
    the total mod 10 must be zero.
    """
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = ord(ch) - 48
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def validate_sa_id(raw: str) -> Tuple[bool, str]:
    """Return (ok, message). `message` is a short reason on failure or the
    date of birth ISO string on success (useful for downstream persistence)."""
    if raw is None:
        return False, "SA ID Number is required."
    digits = "".join(ch for ch in str(raw) if ch.isdigit())
    if len(digits) != 13:
        return False, "SA ID Number must be exactly 13 digits."
    yy = int(digits[0:2])
    mm = int(digits[2:4])
    dd = int(digits[4:6])
    # Pivot year: 00–24 → 2000s, 25–99 → 1900s. Adjust if we ever hit 2025-01-01
    # birthdays entering the system with a genuine `00` prefix; for now this
    # is safe as SA IDs are only issued from age ~16+.
    century = 2000 if yy <= 24 else 1900
    try:
        date(century + yy, mm, dd)
    except ValueError:
        return False, "SA ID Number contains an invalid date of birth."
    if not _luhn_ok(digits):
        return False, "SA ID Number failed the checksum — please double-check the digits."
    return True, f"{century + yy:04d}-{mm:02d}-{dd:02d}"
