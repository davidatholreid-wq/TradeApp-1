"""Cover Offers routes (Pricing Agents).

Extracted from `backend/server.py` on 2026-08-09 as the fourth
proof-of-concept in the Phase 2 route-splitting effort.

A pricing-agent is a special dealer who can price other dealers'
submissions. Their offers ("covers") are binding-subject-to-inspection,
billed R10 per cover placed. The Fourbuy admin Offer / admin_pricing
are stripped from what they see so they price without anchoring.

Owns 8 routes:
    * PATCH  /admin/users/{user_id}/pricing-agent     (admin toggle)
    * GET    /cover/declined-submissions
    * GET    /cover/submissions
    * POST   /cover/submissions/{sub_id}/decline
    * DELETE /cover/submissions/{sub_id}/decline
    * GET    /cover/submissions/{sub_id}
    * POST   /submissions/{sub_id}/covers             (place a cover offer)
    * GET    /submissions/{sub_id}/covers             (list covers on a sub)

`COVER_OFFER_COST_ZAR`, `_sanitise_sub_for_pricing_agent`, and
`require_pricing_agent` are exported here (via `__all__`) so `server.py`
can re-import them for the non-cover code path that also references
`_sanitise_sub_for_pricing_agent` (the pricing-agent submission-view).
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

# Late-import from `server` — safe because by the time this module is
# imported (at the bottom of `server.py`), the parent module has fully
# defined every name we pull in below.
from server import (
    db,
    get_current_user,
    require_admin,
    now_utc,
)


router = APIRouter()


COVER_OFFER_COST_ZAR = 10.0


def _sanitise_sub_for_pricing_agent(sub: dict) -> dict:
    """Return a copy of the submission dict with fields hidden that a
    pricing agent must NOT see: the Fourbuy admin Offer, admin_pricing,
    and any other Fourbuy-side price signals. Everything else (photos,
    condition, recon, warranty, VIN reports, AI market analysis,
    AutoTrader deep link, service history etc.) stays visible.
    """
    hidden = {"admin_pricing", "offer_to_dealer_zar", "fourbuy_offer_zar",
              "admin_notes", "admin_price_zar",
              # Dealer's private deal-tracking info — cost, sale, profit —
              # must never be visible to pricing agents.
              "deal"}
    return {k: v for k, v in sub.items() if k not in hidden}


@router.patch("/admin/users/{user_id}/pricing-agent")
async def admin_toggle_pricing_agent(
    user_id: str,
    payload: dict,
    current: dict = Depends(require_admin),
):
    """Admin-only toggle for a user's `is_pricing_agent` flag."""
    enabled = bool(payload.get("enabled"))
    result = await db.users.update_one(
        {"id": user_id, "role": "dealer"},
        {"$set": {"is_pricing_agent": enabled}},
    )
    if result.matched_count == 0:
        raise HTTPException(404, "Dealer user not found")
    return {"ok": True, "user_id": user_id, "is_pricing_agent": enabled}


async def require_pricing_agent(current: dict = Depends(get_current_user)) -> dict:
    if not current.get("is_pricing_agent"):
        raise HTTPException(403, "This action is available to pricing agents only.")
    return current


@router.get("/cover/declined-submissions")
async def list_declined_cover_submissions(
    current: dict = Depends(require_pricing_agent),
):
    """Pricing-agent-only. Returns the full vehicle payload for every
    submission this agent has previously swiped-to-decline. Used to
    power the "Declined" silo on the Give Cover screen so an agent can
    retrieve a declined lead later and place a cover on it after all.

    Rows are:
      - Sorted newest-declined first
      - Filtered to only include submissions that are still live
        (status in {pending, priced}) — a decline on an archived sub is
        auto-hidden here because it can never be actioned again
      - Excluded when the agent has since covered them (shouldn't happen
        because the list endpoint auto-clears the decline, but we belt-
        and-braces filter here too)
    """
    my_dealership = current.get("dealership_id")
    declines = await db.cover_declines.find(
        {"agent_user_id": current["id"]},
        {"_id": 0, "submission_id": 1, "declined_at": 1},
    ).sort("declined_at", -1).to_list(2000)
    if not declines:
        return {"submissions": []}

    sub_ids = [d["submission_id"] for d in declines if d.get("submission_id")]
    declined_at_by_id = {d["submission_id"]: d.get("declined_at") for d in declines}

    subs = await db.submissions.find(
        {
            "id": {"$in": sub_ids},
            "status": {"$in": ["pending", "priced"]},
            "dealership_id": {"$ne": my_dealership},
        },
        {
            "_id": 0, "id": 1, "reference": 1, "make_name": 1, "model_name": 1,
            "derivative_name": 1, "year_of_production": 1, "year_registered": 1,
            "mileage": 1, "status": 1, "photos": 1, "vin": 1, "colour": 1,
            "fuel_type": 1, "transmission": 1, "created_at": 1,
        },
    ).to_list(2000)

    # Exclude subs the agent has now covered (edge case — the auto-clear
    # in list_cover_submissions would normally have already removed the
    # decline record).
    my_covers = await db.cover_offers.find(
        {"agent_user_id": current["id"], "submission_id": {"$in": [s["id"] for s in subs]}},
        {"_id": 0, "submission_id": 1},
    ).to_list(2000)
    covered_ids = {c["submission_id"] for c in my_covers}

    # Attach thumbnails + decline timestamps, and preserve the
    # newest-declined-first ordering.
    ordered: dict[str, dict] = {}
    for s in subs:
        if s["id"] in covered_ids:
            continue
        photos = s.get("photos")
        thumb = None
        if isinstance(photos, dict):
            for k in ("front", "driver_side", "passenger_side", "rear", "interior"):
                if photos.get(k):
                    thumb = photos[k]
                    break
            if not thumb:
                thumb = next((v for v in photos.values() if v), None)
        elif isinstance(photos, list):
            thumb = photos[0] if photos else None
        s["thumbnail"] = thumb
        s["declined_at"] = declined_at_by_id.get(s["id"])
        ordered[s["id"]] = s

    out = [ordered[sid] for sid in sub_ids if sid in ordered]
    return {"submissions": out}


@router.get("/cover/submissions")
async def list_cover_submissions(current: dict = Depends(require_pricing_agent)):
    """List submissions available for a pricing agent to price.

    Rules: status in {pending, priced}, not a draft, and NOT owned by
    this agent's dealership (they can't cover their own stock). Any
    submissions this agent has explicitly declined (via swipe-to-decline)
    are also hidden — unless they've placed a cover on it since (in
    which case the decline is auto-cleared server-side).
    """
    my_dealership = current.get("dealership_id")
    # Load the set of submission ids this agent has declined. We keep
    # this in a dedicated collection so undecline / audit is trivial.
    declined_docs = await db.cover_declines.find(
        {"agent_user_id": current["id"]},
        {"_id": 0, "submission_id": 1},
    ).to_list(5000)
    declined_ids = {d["submission_id"] for d in declined_docs if d.get("submission_id")}
    cursor = db.submissions.find(
        {
            "status": {"$in": ["pending", "priced"]},
            "dealership_id": {"$ne": my_dealership},
        },
        {
            "_id": 0, "id": 1, "reference": 1, "make_name": 1, "model_name": 1,
            "derivative_name": 1, "year_of_production": 1, "year_registered": 1,
            "mileage": 1, "status": 1, "photos": 1, "vin": 1, "colour": 1,
            "fuel_type": 1, "transmission": 1, "created_at": 1,
        },
    ).sort("created_at", -1)
    subs = await cursor.to_list(500)
    # Attach my own cover for each (if any) — so the UI can flip the
    # button to "Cover placed · R<amount>".
    my_covers = await db.cover_offers.find(
        {"agent_user_id": current["id"]},
        {"_id": 0, "submission_id": 1, "price_zar": 1, "created_at": 1},
    ).to_list(1000)
    covers_by_sub = {c["submission_id"]: c for c in my_covers}
    filtered: list = []
    for s in subs:
        sid = s["id"]
        c = covers_by_sub.get(sid)
        s["my_cover"] = c if c else None
        # If the agent has already declined this sub, hide it — UNLESS
        # they have subsequently placed a cover (edge case: they
        # declined, then reopened the deep-link and gave cover). In
        # that case honour the cover and clear the decline.
        if sid in declined_ids and not c:
            continue
        if sid in declined_ids and c:
            # Best-effort auto-cleanup; ignore failure.
            try:
                await db.cover_declines.delete_one({"agent_user_id": current["id"], "submission_id": sid})
            except Exception:
                pass
        # Derive a single "thumbnail" URL from whichever photo role is
        # present first — the frontend list card renders this. `photos`
        # in Fourbuy submissions is a dict keyed by role
        # (front / driver_side / passenger_side / rear / interior) so
        # we can't just do `photos[0]`.
        photos = s.get("photos")
        thumb = None
        if isinstance(photos, dict):
            for k in ("front", "driver_side", "passenger_side", "rear", "interior"):
                if photos.get(k):
                    thumb = photos[k]
                    break
            if not thumb:
                # Fallback: first non-empty value.
                thumb = next((v for v in photos.values() if v), None)
        elif isinstance(photos, list):
            thumb = photos[0] if photos else None
        s["thumbnail"] = thumb
        filtered.append(s)
    return {"submissions": filtered}


@router.post("/cover/submissions/{sub_id}/decline")
async def decline_cover_submission(
    sub_id: str, current: dict = Depends(require_pricing_agent)
):
    """Pricing agent swipes-to-decline a submission → it no longer
    appears in their `available to cover` list. This is a personal
    filter — the submission remains fully available to every other
    pricing agent. Placing a cover later automatically clears the
    decline (see list_cover_submissions above)."""
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0, "id": 1, "dealership_id": 1, "status": 1})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if sub.get("dealership_id") == current.get("dealership_id"):
        raise HTTPException(403, "You cannot decline your own stock.")
    await db.cover_declines.update_one(
        {"agent_user_id": current["id"], "submission_id": sub_id},
        {"$set": {
            "agent_user_id": current["id"],
            "submission_id": sub_id,
            "declined_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    return {"status": "declined"}


@router.delete("/cover/submissions/{sub_id}/decline")
async def undo_decline_cover_submission(
    sub_id: str, current: dict = Depends(require_pricing_agent)
):
    """Undo a decline (used by the client-side "Undo" toast after a
    swipe). Safe no-op if the decline was never persisted."""
    await db.cover_declines.delete_one(
        {"agent_user_id": current["id"], "submission_id": sub_id}
    )
    return {"status": "restored"}


@router.get("/cover/submissions/{sub_id}")
async def get_cover_submission(sub_id: str, current: dict = Depends(require_pricing_agent)):
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if sub.get("dealership_id") == current.get("dealership_id"):
        raise HTTPException(403, "You cannot cover your own stock.")
    if sub.get("status") == "draft":
        raise HTTPException(404, "Draft submissions cannot be covered.")
    # Load its report_orders — pricing agents see the reports the owning
    # dealer ordered (JLR OSH, BMW options, Kredo accident, CarTrust).
    reports = await db.report_orders.find(
        {"submission_id": sub_id}, {"_id": 0}
    ).to_list(50)
    my_cover = await db.cover_offers.find_one(
        {"submission_id": sub_id, "agent_user_id": current["id"]},
        {"_id": 0},
    )
    return {
        "submission": _sanitise_sub_for_pricing_agent(sub),
        "report_orders": reports,
        "my_cover": my_cover,
        "cover_cost_zar": COVER_OFFER_COST_ZAR,
    }


@router.post("/submissions/{sub_id}/covers")
async def place_cover_offer(
    sub_id: str,
    payload: dict,
    current: dict = Depends(require_pricing_agent),
):
    """Place OR update a binding cover offer.

    Each call bills R10 to the agent's dealership on their next invoice —
    including updates to an existing cover (the update is treated as a
    fresh binding cover attempt with its own R10 charge). Previous prices
    are pushed onto the offer's `history[]` for full auditability.
    """
    try:
        price = int(payload.get("price_zar") or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "Invalid price_zar")
    if price <= 0:
        raise HTTPException(400, "price_zar must be a positive integer")
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
    if not sub:
        raise HTTPException(404, "Submission not found")
    if sub.get("dealership_id") == current.get("dealership_id"):
        raise HTTPException(403, "You cannot cover your own stock.")
    if sub.get("status") == "draft":
        raise HTTPException(400, "This submission is a draft.")
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    note = (payload.get("note") or "").strip() or None
    existing = await db.cover_offers.find_one(
        {"submission_id": sub_id, "agent_user_id": current["id"]}
    )
    if existing:
        # UPDATE path — push previous price to history, replace price/note.
        # Updates are NOT billed — only the initial cover placement is
        # billed. Cover remains binding subject to inspection.
        prev_history = existing.get("history") or []
        prev_history.append({
            "price_zar": existing.get("price_zar"),
            "note": existing.get("note"),
            "at": existing.get("updated_at") or existing.get("created_at"),
        })
        await db.cover_offers.update_one(
            {"id": existing["id"]},
            {"$set": {
                "price_zar": price,
                "note": note,
                "updated_at": now_iso,
                "history": prev_history,
            }},
        )
        cover_id = existing["id"]
        # No R10 bill for updates — return early with the fresh cover doc.
        fresh = await db.cover_offers.find_one({"id": cover_id}, {"_id": 0})
        return {"ok": True, "cover": fresh, "billed_zar": 0}
    else:
        # First-time cover.
        cover_id = str(uuid.uuid4())
        offer = {
            "id": cover_id,
            "submission_id": sub_id,
            "agent_user_id": current["id"],
            "agent_dealership_id": current.get("dealership_id"),
            "price_zar": price,
            "note": note,
            "status": "active",
            "created_at": now_iso,
            "updated_at": now_iso,
            "history": [],
            "binding_caveat": (
                "Cover is binding subject to physical inspection of the vehicle "
                "and confirmation that all details in the submission (mileage, "
                "condition, service history, accident/claim status, warranty and "
                "reconditioning) are accurate."
            ),
        }
        await db.cover_offers.insert_one(offer)
        billing_note = f"Cover of R{price:,} placed on submission {sub.get('reference')}."
    # Bill R10 to the pricing-agent — ONLY on the first-time cover
    # placement (updates skip this via the early return above).
    await db.report_orders.insert_one({
        "id": str(uuid.uuid4()),
        "submission_id": sub_id,
        "dealer_id": current.get("id"),  # matches billing member_ids lookup
        "type": "cover_offer",
        "name": f"Cover Offer · {sub.get('reference') or sub_id[:8]}",
        "cost_zar": COVER_OFFER_COST_ZAR,
        "status": "delivered",
        "ordered_at": now_iso,
        "ordered_by": current["id"],
        "delivered_at": now_iso,
        "note": billing_note,
        "cover_offer_id": cover_id,
    })
    # Return the fresh cover doc so the UI can refresh without re-fetching.
    fresh = await db.cover_offers.find_one({"id": cover_id}, {"_id": 0})
    return {"ok": True, "cover": fresh, "billed_zar": COVER_OFFER_COST_ZAR}


@router.get("/submissions/{sub_id}/covers")
async def list_covers_for_submission(sub_id: str, current: dict = Depends(get_current_user)):
    """List covers on a submission. Visible to (a) the submission owner's
    dealership, (b) admins, (c) the pricing agent who placed each cover.
    Not visible to other pricing agents to prevent price scanning.
    """
    sub = await db.submissions.find_one({"id": sub_id}, {"_id": 0, "dealership_id": 1})
    if not sub:
        raise HTTPException(404, "Submission not found")
    is_admin = current.get("role") == "admin"
    is_owner = sub.get("dealership_id") and sub["dealership_id"] == current.get("dealership_id")
    if not (is_admin or is_owner):
        # Pricing agent: only their own cover on this sub.
        if current.get("is_pricing_agent"):
            own = await db.cover_offers.find_one(
                {"submission_id": sub_id, "agent_user_id": current["id"]},
                {"_id": 0},
            )
            return {"covers": [own] if own else []}
        raise HTTPException(403, "Not authorised.")
    covers = await db.cover_offers.find(
        {"submission_id": sub_id}, {"_id": 0},
    ).sort("price_zar", -1).to_list(100)
    # Enrich with agent name + WhatsApp phone from the user record.
    agent_ids = list({c["agent_user_id"] for c in covers})
    agents = {}
    if agent_ids:
        async for u in db.users.find(
            {"id": {"$in": agent_ids}},
            {
                "_id": 0,
                "id": 1,
                "dealer_info": 1,
                "dealership_id": 1,
                # `profile_pic` lives at the top-level of the user
                # document (Cloudinary URL, populated via the profile
                # editor). Older code looked for `dealer_info.
                # profile_photo` which was never populated — that's why
                # cover rows rendered the fallback initial disc even
                # when the agent had uploaded a proper avatar.
                "profile_pic": 1,
            },
        ):
            info = u.get("dealer_info") or {}
            agents[u["id"]] = {
                "name": (
                    (info.get("first_name") or "") + " " + (info.get("last_name") or "")
                ).strip() or "Pricing agent",
                "phone": info.get("phone") or "",
                "dealership_id": u.get("dealership_id"),
                # Round profile pic rendered next to the agent's name in
                # the covers row so the receiving dealer instantly
                # recognises who placed the bind. Fall back to the
                # legacy `dealer_info.profile_photo` key just in case
                # older records still use it.
                "profile_pic": u.get("profile_pic") or info.get("profile_photo") or None,
            }
    # Attach dealership names in one batch.
    dship_ids = list({a["dealership_id"] for a in agents.values() if a.get("dealership_id")})
    dship_map: dict[str, str] = {}
    if dship_ids:
        async for d in db.dealerships.find(
            {"id": {"$in": dship_ids}}, {"_id": 0, "id": 1, "name": 1},
        ):
            dship_map[d["id"]] = d.get("name") or ""
    for c in covers:
        a = agents.get(c["agent_user_id"], {})
        c["agent_name"] = a.get("name")
        c["agent_phone"] = a.get("phone")
        c["agent_dealership_name"] = dship_map.get(a.get("dealership_id") or "")
        c["agent_profile_pic"] = a.get("profile_pic")
    return {"covers": covers}




__all__ = [
    "router",
    "COVER_OFFER_COST_ZAR",
    "_sanitise_sub_for_pricing_agent",
    "require_pricing_agent",
]
