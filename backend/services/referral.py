"""Referral code generation.

Every dealer user receives a lifetime referral code at account creation
(or lazily on first `/auth/me` for pre-existing users). The code is a
6-character alphanumeric string — uppercase, using an unambiguous alphabet
(no 0/O/1/I/L) so it's safe to share by voice / handwriting.
"""
from __future__ import annotations

import secrets
from typing import Awaitable, Callable

# Unambiguous uppercase alphabet — 30 symbols, no confusing look-alikes.
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LEN = 6


def new_code() -> str:
    """Return a single random referral code (no uniqueness check)."""
    return "".join(secrets.choice(ALPHABET) for _ in range(CODE_LEN))


async def allocate_unique_code(
    exists: Callable[[str], Awaitable[bool]],
    attempts: int = 12,
) -> str:
    """Return a referral code that is not yet in use.

    `exists(code)` is an async callable — usually
    `lambda c: db.users.count_documents({"referral_code": c}) > 0`.
    """
    for _ in range(attempts):
        code = new_code()
        if not await exists(code):
            return code
    raise RuntimeError("Could not allocate a unique referral code after retries.")
