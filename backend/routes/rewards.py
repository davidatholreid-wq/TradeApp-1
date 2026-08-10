"""Fourbuy Rewards routes (voucher redemptions + admin ledger).

Extracted from `backend/server.py` on 2026-08-09 as the second
proof-of-concept in the Phase 2 route-splitting effort.

Owns 8 routes:
    * GET  /rewards/me
    * POST /rewards/redeem
    * GET  /admin/reward-redemptions
    * POST /admin/reward-redemptions/{id}/fulfill
    * POST /admin/reward-redemptions/{id}/reject
    * GET  /admin/rewards/leaderboard
    * GET  /admin/rewards/users
    * POST /admin/rewards/grant

Rewards constants (REWARD_*) and the ledger helpers
(get_user_reward_balance / spend_points / refund_points /
award_reward_point_for_submission) remain in `server.py` because they
are also used by non-rewards code paths (submission pricing, referral
crediting, etc.) — this module late-imports them.
"""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr

# Late-import from `server` — safe because by the time this module is
# imported (at the bottom of `server.py`), the parent module has fully
# defined every name we pull in below.
from server import (
    db,
    get_current_user,
    require_admin,
    now_utc,
    send_push,
    logger,
    get_user_reward_balance,
    spend_points,
    refund_points,
    REWARD_POINT_LABEL,
    REWARD_POINTS_PER_VOUCHER,
    REWARD_VOUCHER_VALUE_ZAR,
    REWARD_VOUCHER_PROVIDER,
)


router = APIRouter()


class RedeemRequest(BaseModel):
    # Where the user wants the voucher emailed to. Defaults to their login email.
    desired_email: Optional[EmailStr] = None


class RedemptionActionRequest(BaseModel):
    voucher_code: Optional[str] = None
    admin_note: Optional[str] = None


class RewardGrantRequest(BaseModel):
    """Admin adjustment to a user's reward balance. Positive `points` credits
    the account, negative debits. `reason` is required and stored in the
    ledger note so bonus/goodwill adjustments remain fully auditable."""
    user_id: str
    points: int
    reason: str


@router.get("/rewards/me")
async def rewards_me(current: dict = Depends(get_current_user)):
    """Dealer's own rewards summary: balance, next threshold, ledger and
    redemption history."""
    if current.get("role") != "dealer":
        raise HTTPException(400, "Only dealer users have a rewards balance")
    balance = await get_user_reward_balance(current["id"])
    # Ledger — newest first, capped so we don't ship huge payloads.
    ledger = await db.reward_ledger.find(
        {"user_id": current["id"]},
        {"_id": 0},
    ).sort("at", -1).to_list(200)
    redemptions = await db.reward_redemptions.find(
        {"user_id": current["id"]},
        {"_id": 0},
    ).sort("requested_at", -1).to_list(200)
    total_earned = sum(int(e.get("delta") or 0) for e in ledger if e.get("type") in ("earn", "referral_earn"))
    total_spent = sum(abs(int(e.get("delta") or 0)) for e in ledger if e.get("type") == "spend")
    total_refunded = sum(int(e.get("delta") or 0) for e in ledger if e.get("type") == "refund")
    total_referred = sum(int(e.get("delta") or 0) for e in ledger if e.get("type") == "referral_earn")

    # Referred dealers list — every dealer who signed up via *this* user's
    # referral code. Never exposes email / phone / SA-ID; only safe display
    # fields so the referrer can see their "network" in the Rewards tab.
    referred_users_cursor = db.users.find(
        {"referred_by_user_id": current["id"], "role": "dealer"},
        {
            "_id": 0,
            "id": 1,
            "dealer_info": 1,
            "dealership_id": 1,
            "active": 1,
            "archived_at": 1,
            "created_at": 1,
        },
    ).sort("created_at", -1)
    referred_users = await referred_users_cursor.to_list(500)
    referred_dealers: list[dict] = []
    # Pre-compute per-referee points earned by the current user, in one pass.
    points_by_referee: dict[str, int] = {}
    for row in ledger:
        if row.get("type") == "referral_earn":
            rid = row.get("referral_of_user_id")
            if rid:
                points_by_referee[rid] = points_by_referee.get(rid, 0) + int(row.get("delta") or 0)
    # Batch-fetch dealership names for the referees.
    dship_ids = {u.get("dealership_id") for u in referred_users if u.get("dealership_id")}
    dship_map: dict[str, str] = {}
    if dship_ids:
        async for dship in db.dealerships.find(
            {"id": {"$in": list(dship_ids)}},
            {"_id": 0, "id": 1, "name": 1},
        ):
            dship_map[dship["id"]] = dship.get("name") or ""

    for u in referred_users:
        info = u.get("dealer_info") or {}
        first = (info.get("first_name") or "").strip()
        last = (info.get("last_name") or "").strip()
        name = (first + " " + last).strip() or "Fourbuy dealer"
        if u.get("archived_at"):
            status = "archived"
        elif u.get("active") is False:
            status = "suspended"
        else:
            status = "active"
        referred_dealers.append({
            "id": u["id"],
            "name": name,
            "dealership": dship_map.get(u.get("dealership_id") or "", None),
            "joined_at": u.get("created_at"),
            "status": status,
            "points_earned_from": int(points_by_referee.get(u["id"], 0)),
        })

    return {
        "label": REWARD_POINT_LABEL,
        "balance": balance,
        "points_per_voucher": REWARD_POINTS_PER_VOUCHER,
        "voucher_value_zar": REWARD_VOUCHER_VALUE_ZAR,
        "voucher_provider": REWARD_VOUCHER_PROVIDER,
        "can_redeem": balance >= REWARD_POINTS_PER_VOUCHER,
        "points_to_next_voucher": max(0, REWARD_POINTS_PER_VOUCHER - balance),
        "totals": {
            "earned": total_earned,
            "spent": total_spent,
            "refunded": total_refunded,
            "referred": total_referred,
        },
        "ledger": ledger,
        "redemptions": redemptions,
        "referral_code": current.get("referral_code"),
        "referred_dealers": referred_dealers,
    }


@router.post("/rewards/redeem")
async def rewards_redeem(payload: RedeemRequest, current: dict = Depends(get_current_user)):
    """Dealer submits a voucher redemption. Points are debited immediately
    (prevents double-redemption) — refunded if the admin later rejects."""
    if current.get("role") != "dealer":
        raise HTTPException(400, "Only dealer users can redeem")
    balance = await get_user_reward_balance(current["id"])
    if balance < REWARD_POINTS_PER_VOUCHER:
        raise HTTPException(400, f"Not enough points — you have {balance} of {REWARD_POINTS_PER_VOUCHER} required")
    desired_email = (payload.desired_email or current.get("email") or "").strip().lower()
    if not desired_email:
        raise HTTPException(400, "A delivery email is required")
    redemption_id = str(uuid.uuid4())
    info = current.get("dealer_info") or {}
    doc = {
        "id": redemption_id,
        "user_id": current["id"],
        "user_name": (f"{info.get('first_name','')} {info.get('last_name','')}".strip()) or None,
        "user_email": current.get("email"),
        "user_job_title": info.get("job_title"),
        "dealership_id": current.get("dealership_id"),
        "requested_email": desired_email,
        "points_cost": REWARD_POINTS_PER_VOUCHER,
        "voucher_value_zar": REWARD_VOUCHER_VALUE_ZAR,
        "voucher_provider": REWARD_VOUCHER_PROVIDER,
        "status": "pending",
        "voucher_code": None,
        "admin_note": None,
        "actioned_by_admin_id": None,
        "actioned_at": None,
        "requested_at": now_utc(),
    }
    await db.reward_redemptions.insert_one(doc)
    await spend_points(
        current["id"], REWARD_POINTS_PER_VOUCHER, redemption_id,
        f"Voucher redemption request → {desired_email}",
    )
    # Notify all admins so they can action promptly.
    try:
        admin_ids = [a["id"] async for a in db.users.find({"role": "admin"}, {"_id": 0, "id": 1})]
        if admin_ids:
            await send_push(
                recipients=admin_ids,
                data={
                    "title": "New Voucher Request",
                    "message": f"{doc['user_name'] or current.get('email')} redeemed for a R{REWARD_VOUCHER_VALUE_ZAR} {REWARD_VOUCHER_PROVIDER} voucher.",
                    "action_url": "/admin/rewards",
                },
            )
    except Exception as e:
        logger.warning("Reward redemption push failed (non-blocking): %s", e)
    doc.pop("_id", None)
    fresh_balance = await get_user_reward_balance(current["id"])
    return {"redemption": doc, "balance": fresh_balance}


@router.get("/admin/reward-redemptions")
async def admin_list_redemptions(
    status: Optional[str] = None,
    current: dict = Depends(require_admin),
):
    """Admin inbox — every voucher request across all dealerships. Filter
    by status (pending | fulfilled | rejected) or omit for all."""
    query: dict = {}
    if status:
        query["status"] = status
    docs = await db.reward_redemptions.find(query, {"_id": 0}).sort("requested_at", -1).to_list(500)
    # Enrich with the user's WhatsApp / phone number so the admin can
    # ping the fulfilled voucher straight through WhatsApp.
    uids = list({d.get("user_id") for d in docs if d.get("user_id")})
    if uids:
        users_cursor = db.users.find(
            {"id": {"$in": uids}},
            {"_id": 0, "id": 1, "dealer_info": 1},
        )
        phones: dict = {}
        async for u in users_cursor:
            info = u.get("dealer_info") or {}
            phone = (info.get("phone") or info.get("whatsapp") or "").strip()
            if phone:
                phones[u["id"]] = phone
        for d in docs:
            uid = d.get("user_id")
            if uid and uid in phones:
                d["user_phone"] = phones[uid]
    pending = sum(1 for d in docs if d.get("status") == "pending")
    return {
        "redemptions": docs,
        "pending_count": pending,
        "voucher_value_zar": REWARD_VOUCHER_VALUE_ZAR,
        "voucher_provider": REWARD_VOUCHER_PROVIDER,
    }


@router.post("/admin/reward-redemptions/{redemption_id}/fulfill")
async def admin_fulfill_redemption(
    redemption_id: str,
    payload: RedemptionActionRequest,
    current: dict = Depends(require_admin),
):
    r = await db.reward_redemptions.find_one({"id": redemption_id})
    if not r:
        raise HTTPException(404, "Redemption not found")
    if r.get("status") != "pending":
        raise HTTPException(400, f"Cannot fulfil a {r.get('status')} redemption")
    code = (payload.voucher_code or "").strip()
    if not code:
        raise HTTPException(400, "voucher_code is required")
    await db.reward_redemptions.update_one(
        {"id": redemption_id},
        {"$set": {
            "status": "fulfilled",
            "voucher_code": code,
            "admin_note": (payload.admin_note or "").strip() or None,
            "actioned_by_admin_id": current["id"],
            "actioned_at": now_utc(),
        }},
    )
    # Also log to the ledger for full auditability (no delta — informational).
    await db.reward_ledger.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": r["user_id"],
        "type": "fulfill",
        "delta": 0,
        "redemption_id": redemption_id,
        "note": f"Voucher issued · code {code[:4]}…",
        "at": now_utc(),
    })
    try:
        await send_push(
            recipients=[r["user_id"]],
            data={
                "title": "Voucher Ready",
                "message": f"Your R{r.get('voucher_value_zar')} {r.get('voucher_provider')} voucher code is on the way.",
                "action_url": "/rewards",
            },
        )
    except Exception as e:
        logger.warning("Fulfill push failed (non-blocking): %s", e)
    fresh = await db.reward_redemptions.find_one({"id": redemption_id}, {"_id": 0})
    return {"redemption": fresh}


@router.post("/admin/reward-redemptions/{redemption_id}/reject")
async def admin_reject_redemption(
    redemption_id: str,
    payload: RedemptionActionRequest,
    current: dict = Depends(require_admin),
):
    r = await db.reward_redemptions.find_one({"id": redemption_id})
    if not r:
        raise HTTPException(404, "Redemption not found")
    if r.get("status") != "pending":
        raise HTTPException(400, f"Cannot reject a {r.get('status')} redemption")
    reason = (payload.admin_note or "").strip() or "Rejected by admin"
    await db.reward_redemptions.update_one(
        {"id": redemption_id},
        {"$set": {
            "status": "rejected",
            "admin_note": reason,
            "actioned_by_admin_id": current["id"],
            "actioned_at": now_utc(),
        }},
    )
    await refund_points(
        r["user_id"], r.get("points_cost") or REWARD_POINTS_PER_VOUCHER, redemption_id,
        f"Refund · {reason}",
    )
    try:
        await send_push(
            recipients=[r["user_id"]],
            data={
                "title": "Voucher Request Rejected",
                "message": f"Your points have been refunded. Reason: {reason}",
                "action_url": "/rewards",
            },
        )
    except Exception as e:
        logger.warning("Reject push failed (non-blocking): %s", e)
    fresh = await db.reward_redemptions.find_one({"id": redemption_id}, {"_id": 0})
    return {"redemption": fresh}


@router.get("/admin/rewards/leaderboard")
async def admin_rewards_leaderboard(
    limit: int = 20,
    current: dict = Depends(require_admin),
):
    """Rewards leaderboard.

    Returns two sorted lists:
      * `current` — current balance (net available points per user), descending.
      * `all_time` — lifetime points ever earned (excludes admin debits so
        prior earnings are preserved as history), descending.

    Only users who have ever been in the ledger are returned so we don't
    ship a huge zero-row payload.
    """
    limit = max(1, min(int(limit or 20), 100))

    balances: dict[str, int] = {}
    lifetime: dict[str, int] = {}
    async for e in db.reward_ledger.find(
        {}, {"_id": 0, "user_id": 1, "delta": 1, "type": 1}
    ):
        uid = e.get("user_id")
        if not uid:
            continue
        delta = int(e.get("delta") or 0)
        balances[uid] = balances.get(uid, 0) + delta
        if delta > 0 and e.get("type") in ("earn", "adjust"):
            lifetime[uid] = lifetime.get(uid, 0) + delta

    uids = list({*balances.keys(), *lifetime.keys()})
    if not uids:
        return {"current": [], "all_time": [], "points_per_voucher": REWARD_POINTS_PER_VOUCHER}

    users = await db.users.find(
        {"id": {"$in": uids}, "role": "dealer"},
        {"_id": 0, "password_hash": 0},
    ).to_list(len(uids))
    dealership_ids = list({u.get("dealership_id") for u in users if u.get("dealership_id")})
    dealership_docs = await db.dealerships.find(
        {"id": {"$in": dealership_ids}}, {"_id": 0, "id": 1, "name": 1}
    ).to_list(len(dealership_ids)) if dealership_ids else []
    d_by_id = {d["id"]: d for d in dealership_docs}

    def _shape(u: dict) -> dict:
        info = u.get("dealer_info") or {}
        first = info.get("first_name") or ""
        last = info.get("last_name") or ""
        name = f"{first} {last}".strip() or (u.get("email") or "")
        d = d_by_id.get(u.get("dealership_id") or "")
        return {
            "id": u["id"],
            "email": u.get("email"),
            "name": name,
            "job_title": info.get("job_title"),
            "dealership_id": u.get("dealership_id"),
            "dealership_name": (d or {}).get("name"),
            "balance": max(0, balances.get(u["id"], 0)),
            "lifetime_earned": lifetime.get(u["id"], 0),
        }

    shaped = [_shape(u) for u in users]

    current_sorted = sorted(shaped, key=lambda x: x["balance"], reverse=True)[:limit]
    all_time_sorted = sorted(shaped, key=lambda x: x["lifetime_earned"], reverse=True)[:limit]

    # Rank + trim zeroes off the tail so the board doesn't fill with empty rows.
    def _rank(rows: list[dict], key: str) -> list[dict]:
        out = []
        rank = 0
        prev_val: Optional[int] = None
        for i, r in enumerate(rows, start=1):
            val = r[key]
            if val <= 0:
                continue
            if val != prev_val:
                rank = i
                prev_val = val
            out.append({**r, "rank": rank})
        return out

    return {
        "current": _rank(current_sorted, "balance"),
        "all_time": _rank(all_time_sorted, "lifetime_earned"),
        "points_per_voucher": REWARD_POINTS_PER_VOUCHER,
    }


@router.get("/admin/rewards/users")
async def admin_list_reward_users(current: dict = Depends(require_admin)):
    """List all dealer users with their current reward balance. Powers the
    admin "grant bonus points" picker."""
    users = await db.users.find(
        {"role": "dealer"},
        {"_id": 0, "password_hash": 0},
    ).to_list(1000)
    # Bulk-sum ledger deltas so we don't do N round-trips.
    balances: dict[str, int] = {}
    async for e in db.reward_ledger.find({}, {"_id": 0, "user_id": 1, "delta": 1}):
        uid = e.get("user_id")
        if not uid:
            continue
        balances[uid] = balances.get(uid, 0) + int(e.get("delta") or 0)
    dealership_ids = list({u.get("dealership_id") for u in users if u.get("dealership_id")})
    dealership_docs = await db.dealerships.find(
        {"id": {"$in": dealership_ids}}, {"_id": 0, "id": 1, "name": 1}
    ).to_list(1000) if dealership_ids else []
    d_by_id = {d["id"]: d for d in dealership_docs}
    out = []
    for u in users:
        info = u.get("dealer_info") or {}
        first = info.get("first_name") or ""
        last = info.get("last_name") or ""
        name = f"{first} {last}".strip() or (u.get("email") or "")
        d = d_by_id.get(u.get("dealership_id") or "")
        out.append({
            "id": u["id"],
            "email": u.get("email"),
            "name": name,
            "job_title": info.get("job_title"),
            "active": u.get("active", True),
            "dealership_id": u.get("dealership_id"),
            "dealership_name": (d or {}).get("name"),
            "balance": max(0, balances.get(u["id"], 0)),
        })
    out.sort(key=lambda x: (x["dealership_name"] or "", x["name"]))
    return {"users": out, "points_per_voucher": REWARD_POINTS_PER_VOUCHER}


@router.post("/admin/rewards/grant")
async def admin_grant_reward_points(
    payload: RewardGrantRequest,
    current: dict = Depends(require_admin),
):
    """Admin credit / debit of a dealer's reward balance. Positive `points`
    adds a bonus, negative removes. Everything is written to the ledger with
    the admin's identity and reason so this stays fully auditable."""
    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(400, "reason is required")
    if payload.points == 0:
        raise HTTPException(400, "points must be non-zero")
    target = await db.users.find_one(
        {"id": payload.user_id}, {"_id": 0, "password_hash": 0}
    )
    if not target:
        raise HTTPException(404, "User not found")
    if target.get("role") != "dealer":
        raise HTTPException(400, "Bonus points can only be granted to dealer users")

    # If it's a debit, guard against sending the balance below zero.
    delta = int(payload.points)
    if delta < 0:
        current_balance = await get_user_reward_balance(payload.user_id)
        if current_balance + delta < 0:
            raise HTTPException(
                400,
                f"Cannot debit {abs(delta)} pts — user only has {current_balance} pt(s)",
            )

    doc = {
        "id": str(uuid.uuid4()),
        "user_id": payload.user_id,
        "dealership_id": target.get("dealership_id"),
        "type": "adjust",
        "delta": delta,
        "note": f"Admin adjustment · {reason}",
        "granted_by_admin_id": current["id"],
        "granted_by_admin_email": current.get("email"),
        "at": now_utc(),
    }
    await db.reward_ledger.insert_one(doc)
    fresh_balance = await get_user_reward_balance(payload.user_id)
    return {
        "user_id": payload.user_id,
        "delta": delta,
        "balance": fresh_balance,
        "reason": reason,
    }

__all__ = ["router"]
