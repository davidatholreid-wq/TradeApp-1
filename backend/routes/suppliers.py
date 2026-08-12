"""Reconditioning Suppliers routes (dealership-scoped).

Every dealership can maintain their own catalog of reconditioning
suppliers (windscreen guy, tyre fitment, panel-beater, upholsterer,
mechanic). The catalog is:

  * Scoped per **dealership**, not per user — all users on the same
    dealership see the same list.
  * Mutable only by users with "Managerial" access (backend flag is
    still `is_pricing_agent` — kept as-is per the display-label-only
    rename decision).
  * Referenced from the vehicle-detail Deal Tracking flow: once a
    deal is marked done, a managerial user can assign one supplier
    per reconditioning line-item, and the assignment is snapshotted
    onto the submission so the printed Reconditioning Requirement
    Sheet PDF still renders correctly even if the supplier is later
    edited or deleted.

Endpoints:
  * GET    /suppliers                 — list this dealership's active suppliers
  * POST   /suppliers                 — create (managerial only)
  * PUT    /suppliers/{sid}           — update (managerial only)
  * DELETE /suppliers/{sid}           — soft-delete (managerial only)
  * POST   /submissions/{sid}/reconditioning/{index}/supplier
                                       — attach / detach a supplier
                                         to a specific recon line
                                         (managerial only, own submission)
"""

from __future__ import annotations

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from server import (
    db,
    get_current_user,
    now_utc,
    _get_user_dealership_id,
    _can_access_submission,
)


router = APIRouter()


# Categories intentionally mirror the RECON_CATEGORIES enum on the
# frontend (`/app/frontend/app/(app)/submit.tsx`). Kept in sync manually
# for now — a change on the frontend must also be reflected here.
RECON_CATEGORIES = [
    "Bodywork",
    "Interior / Trim",
    "Mechanical",
    "Rims",
    "Tyres",
    "Valet",
    "Windscreen",
]


def _require_managerial(current: dict) -> None:
    """Guard: only users with managerial access can CRUD suppliers or
    assign them to recon items. Admins are allowed too so they can
    manage on a dealer's behalf when supporting them."""
    if current.get("role") == "admin":
        return
    if not current.get("is_pricing_agent"):
        raise HTTPException(
            403,
            "Managerial access required. Ask your dealership admin to enable it on your profile.",
        )


# ==================== Models ====================

class SupplierIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    contact_name: Optional[str] = Field(default=None, max_length=120)
    contact_phone: Optional[str] = Field(default=None, max_length=40)
    categories: List[str] = Field(default_factory=list)

    def sanitised_categories(self) -> List[str]:
        # Deduplicate + clamp to the known enum.
        seen = []
        for c in self.categories or []:
            if c in RECON_CATEGORIES and c not in seen:
                seen.append(c)
        return seen


class SupplierAssignBody(BaseModel):
    # Pass supplier_id=null to clear the assignment on a recon line.
    supplier_id: Optional[str] = None


# ==================== Suppliers CRUD ====================

@router.get("/suppliers")
async def list_suppliers(current: dict = Depends(get_current_user)):
    """Return every active (non-soft-deleted) supplier for the caller's
    dealership. Available to any user on the dealership so that admins
    and pricing-agent users can both READ the list; only managerial
    users can mutate it via POST/PUT/DELETE below.
    """
    dealership_id = await _get_user_dealership_id(current) if current.get("role") != "admin" else None
    if current.get("role") == "admin":
        # Admins can filter by ?dealership_id=... for support workflows.
        # For now, admins get an empty list on the plain GET since suppliers
        # are dealer-owned and the admin cockpit doesn't need to mirror
        # every dealership's list. The dealer-detail screen can extend this
        # later by passing an explicit dealership_id query param.
        return {"suppliers": []}

    if not dealership_id:
        return {"suppliers": []}

    cursor = db.suppliers.find(
        {"dealership_id": dealership_id, "deleted_at": {"$in": [None, False]}},
        {"_id": 0},
    ).sort([("name", 1)])
    docs = await cursor.to_list(500)
    return {"suppliers": docs, "categories": RECON_CATEGORIES}


@router.post("/suppliers")
async def create_supplier(
    body: SupplierIn,
    current: dict = Depends(get_current_user),
):
    _require_managerial(current)
    dealership_id = await _get_user_dealership_id(current)
    if not dealership_id:
        raise HTTPException(400, "Your account is not linked to a dealership.")

    doc = {
        "id": str(uuid.uuid4()),
        "dealership_id": dealership_id,
        "name": body.name.strip(),
        "contact_name": (body.contact_name or "").strip() or None,
        "contact_phone": (body.contact_phone or "").strip() or None,
        "categories": body.sanitised_categories(),
        "created_at": now_utc(),
        "created_by": current.get("id"),
        "updated_at": now_utc(),
        "deleted_at": None,
    }
    await db.suppliers.insert_one(doc)
    doc.pop("_id", None)
    return {"supplier": doc}


@router.put("/suppliers/{sid}")
async def update_supplier(
    sid: str,
    body: SupplierIn,
    current: dict = Depends(get_current_user),
):
    _require_managerial(current)
    dealership_id = await _get_user_dealership_id(current)
    existing = await db.suppliers.find_one({"id": sid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Supplier not found")
    if existing.get("dealership_id") != dealership_id and current.get("role") != "admin":
        raise HTTPException(403, "Not your dealership's supplier")

    update = {
        "name": body.name.strip(),
        "contact_name": (body.contact_name or "").strip() or None,
        "contact_phone": (body.contact_phone or "").strip() or None,
        "categories": body.sanitised_categories(),
        "updated_at": now_utc(),
    }
    await db.suppliers.update_one({"id": sid}, {"$set": update})
    fresh = await db.suppliers.find_one({"id": sid}, {"_id": 0})
    return {"supplier": fresh}


@router.delete("/suppliers/{sid}")
async def delete_supplier(
    sid: str,
    current: dict = Depends(get_current_user),
):
    """Soft-delete: sets `deleted_at`. Existing snapshots on submission
    reconditioning items keep the supplier's captured name / contact so
    the PDF still renders — but the supplier no longer appears in the
    dropdown when assigning to new lines.
    """
    _require_managerial(current)
    dealership_id = await _get_user_dealership_id(current)
    existing = await db.suppliers.find_one({"id": sid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Supplier not found")
    if existing.get("dealership_id") != dealership_id and current.get("role") != "admin":
        raise HTTPException(403, "Not your dealership's supplier")

    await db.suppliers.update_one(
        {"id": sid},
        {"$set": {"deleted_at": now_utc(), "updated_at": now_utc()}},
    )
    return {"status": "deleted", "id": sid}


# ==================== Assign to recon line ====================

@router.post("/submissions/{sub_id}/reconditioning/{index}/supplier")
async def assign_recon_supplier(
    sub_id: str,
    index: int,
    body: SupplierAssignBody,
    current: dict = Depends(get_current_user),
):
    """Attach (or detach) a supplier to a specific reconditioning line
    item on `sub_id`. Body: `{ "supplier_id": "..." }` to attach, or
    `{ "supplier_id": null }` to clear.

    A snapshot (id + name + contact_name + contact_phone) is stored on
    the recon item so the printed Reconditioning Sheet PDF renders the
    supplier even if the supplier row is later edited or deleted.
    """
    _require_managerial(current)

    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if not await _can_access_submission(sub, current):
        raise HTTPException(403, "Not your submission")

    # Only owning-dealership managerial users can assign.
    dealership_id = await _get_user_dealership_id(current)
    if sub.get("dealership_id") != dealership_id and current.get("role") != "admin":
        raise HTTPException(403, "Only the owning dealership can assign suppliers")

    recon = list(sub.get("reconditioning_items") or [])
    if index < 0 or index >= len(recon):
        raise HTTPException(400, f"Recon line {index} does not exist")

    if body.supplier_id:
        supplier = await db.suppliers.find_one(
            {"id": body.supplier_id, "dealership_id": dealership_id},
            {"_id": 0},
        )
        if not supplier:
            raise HTTPException(404, "Supplier not found for this dealership")
        # Snapshot the essential fields so the PDF is stable over time.
        recon[index]["supplier"] = {
            "id": supplier["id"],
            "name": supplier.get("name") or "",
            "contact_name": supplier.get("contact_name") or None,
            "contact_phone": supplier.get("contact_phone") or None,
            "assigned_at": now_utc(),
            "assigned_by": current.get("id"),
        }
    else:
        recon[index].pop("supplier", None)

    await db.submissions.update_one(
        {"id": sub_id},
        {"$set": {"reconditioning_items": recon}},
    )
    return {"ok": True, "item": recon[index]}
