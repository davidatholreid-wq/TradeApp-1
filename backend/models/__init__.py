"""Backend Pydantic schema modules.

Extracted 2026-08-09 as part of a small, low-risk file-hygiene pass.
The vast majority of Pydantic models still live inline in
`backend/server.py`; only clearly-bounded, logic-free groups have been
moved so far. Migrate additional models here on a per-domain basis when
the surrounding route module gets extracted (see Phase 2 backlog).
"""
