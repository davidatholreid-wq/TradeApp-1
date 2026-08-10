"""FastAPI route modules extracted from `backend/server.py`.

These modules each define their own `APIRouter` and are wired into the
main `api_router` at the end of `server.py`. To avoid circular imports,
each route module imports shared runtime state (`db`, auth dependencies,
common helpers) directly from `server` — the import runs AFTER
`server.py` has finished defining those attributes, so Python's partial-
module cycle handling makes this safe.
"""
