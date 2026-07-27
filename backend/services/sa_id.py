"""SA ID Number validation.

South African ID numbers are 13 digits: YYMMDD SSSS C A Z where
  YYMMDD — date of birth (2-digit year, 01-12 month, 01-31 day)
  SSSS   — gender / sequence within DoB (0000-4999 female, 5000-9999 male)
  C      — citizenship (0 SA, 1 permanent resident)
  A      — historically 8/9, kept for backwards compatibility
  Z      — Luhn-style checksum (NO LONGER ENFORCED — see note below)

We enforce two things: exactly 13 digits, and a real calendar date in YYMMDD.

Note on the checksum: some legitimate legacy SA IDs (e.g. IDs issued during
older Home Affairs migrations, foreign nationals with SA-style IDs, and a
handful of clerical corrections) fail the Luhn variant even though the IDs
are genuine. Because we cross-check the DoB and use the ID only as an
identity anchor (not for financial verification), we intentionally do NOT
reject on Luhn failure — this reduces false rejections during dealer
invites at the cost of a slightly weaker typo check.
"""
from __future__ import annotations

from datetime import date
from typing import Tuple


def validate_sa_id(raw: str) -> Tuple[bool, str]:
    """Return (ok, message). `message` is a short reason on failure or the
    date of birth ISO string on success (useful for downstream persistence).
    Length + date-of-birth are enforced; the Luhn checksum is not.
    """
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
    return True, f"{century + yy:04d}-{mm:02d}-{dd:02d}"
