"""Authentication and account routes.

Extracted from `backend/server.py` on 2026-08-09 as the fifth (and
final) proof-of-concept in the Phase 2 route-splitting effort.

Owns 7 routes:
    * POST  /auth/register             (403 — public registration disabled)
    * POST  /auth/login
    * POST  /auth/forgot-password      (email magic link via Emergent Resend)
    * POST  /auth/reset-password
    * GET   /auth/me
    * PATCH /auth/me                   (403 — self-edits disabled)
    * GET   /referral/lookup           (PUBLIC — no auth)

`LoginRequest`, `ForgotPasswordRequest`, `ResetPasswordRequest`, and
`SelfProfileUpdate` Pydantic models are all defined here (moved from
`server.py`).

Because a broken auth module locks EVERY user out, every change here
should be smoke-tested with a live /auth/login round-trip and the
forgot-password rate-limit path before shipping.
"""

from __future__ import annotations

import os
import re
import secrets as _pw_secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import jwt as pyjwt
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr

# Late-import from `server` — safe because by the time this module is
# imported (at the bottom of `server.py`), the parent module has fully
# defined every name we pull in below.
from server import (
    db,
    get_current_user,
    verify_password,
    hash_password,
    sign_token,
    _get_user_dealership_id,
    allocate_unique_code,
    logger,
    JWT_SECRET,
    RegisterRequest,
)


router = APIRouter()


# ============ Login request model ============
class LoginRequest(BaseModel):
    email: EmailStr
    password: str


@router.post("/auth/register")
async def register(payload: RegisterRequest):  # noqa: ARG001 - schema kept for client compatibility
    """Public self-registration is disabled.

    All dealer users must be created by a Fourbuy administrator through
    `POST /api/admin/dealerships/{dealership_id}/users` (or by creating a new
    dealership from the admin cockpit). Returning 403 here keeps the client
    contract explicit while making it impossible for the public web form to
    create accounts.
    """
    raise HTTPException(
        status_code=403,
        detail=(
            "Dealer accounts are created by Fourbuy administrators. "
            "Please contact your Fourbuy admin to be added to your dealership."
        ),
    )


@router.post("/auth/login")
async def login(payload: LoginRequest):
    user = await db.users.find_one({"email": payload.email.lower()})
    if not user or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(401, "Invalid email or password")
    # Suspended or archived dealers cannot log in. Admins are always allowed.
    if user.get("role") == "dealer":
        if user.get("archived_at"):
            raise HTTPException(
                403,
                "This dealer account has been archived. Please contact Fourbuy.",
            )
        if user.get("active") is False:
            raise HTTPException(
                403,
                "Your account has been suspended. Please contact Fourbuy to settle any outstanding balance.",
            )
    token = sign_token(user["id"], user["email"], user["role"])
    # Ensure legacy dealer users have a dealership_id — the startup migration
    # covers this too, but a lazy fallback keeps login robust on fresh dumps.
    dealership_id = None
    referral_code = user.get("referral_code")
    referred_by_payload = None
    if user["role"] == "dealer":
        dealership_id = await _get_user_dealership_id(user)
        # Lazily assign a lifetime referral code to any dealer that doesn't
        # already have one, so the Profile screen renders it immediately
        # after login (instead of only after the next /auth/me refresh).
        if not referral_code:
            async def _code_exists(c: str) -> bool:
                return (await db.users.count_documents({"referral_code": c})) > 0
            referral_code = await allocate_unique_code(_code_exists)
            await db.users.update_one(
                {"id": user["id"]}, {"$set": {"referral_code": referral_code}}
            )
        # Mirror the /auth/me referred_by enrichment so the Profile screen
        # can render "Referred by …" without waiting for a second call.
        rb_id = user.get("referred_by_user_id")
        if rb_id:
            referrer = await db.users.find_one(
                {"id": rb_id},
                {"_id": 0, "dealer_info": 1, "dealership_id": 1, "referral_code": 1},
            )
            if referrer:
                info = referrer.get("dealer_info") or {}
                first = (info.get("first_name") or "").strip()
                last = (info.get("last_name") or "").strip()
                name = (first + " " + last).strip() or "a Fourbuy dealer"
                rb_dship_name = None
                if referrer.get("dealership_id"):
                    rdship = await db.dealerships.find_one(
                        {"id": referrer["dealership_id"]}, {"_id": 0, "name": 1}
                    )
                    rb_dship_name = (rdship or {}).get("name")
                referred_by_payload = {
                    "name": name,
                    "dealership": rb_dship_name,
                    "code": user.get("referred_by_code") or referrer.get("referral_code"),
                }
    return {
        "token": token,
        "user": {
            "id": user["id"],
            "email": user["email"],
            "role": user["role"],
            "active": user.get("active", True),
            "archived_at": user.get("archived_at"),
            "agreement_accepted_at": user.get("agreement_accepted_at"),
            "dealer_info": user.get("dealer_info"),
            "company_info": user.get("company_info"),
            "profile_pic": user.get("profile_pic"),
            "cover_photo": user.get("cover_photo"),
            "dealership_id": dealership_id,
            "referral_code": referral_code,
            "referred_by": referred_by_payload,
            "is_pricing_agent": bool(user.get("is_pricing_agent")),
        },
    }


# ==================================================================
# Password reset via email magic link (Emergent-managed Resend)
# ------------------------------------------------------------------
# Flow:
#   1. Dealer taps "Forgot password?" on the sign-in screen.
#   2. Frontend calls POST /api/auth/forgot-password with their email.
#   3. Backend generates a short-lived, signed reset token (JWT with
#      `type: pwreset`, 30-min TTL), stores its jti in the
#      `password_resets` collection so we can enforce single-use, then
#      emails a magic link:
#          {APP_BASE_URL}/reset-password?token=<jwt>
#   4. Dealer clicks the link -> ResetPassword screen -> POST
#      /api/auth/reset-password with token + new password.
#   5. Backend validates the token + jti (not consumed, not expired),
#      bcrypt-hashes the new password, marks the jti as consumed so it
#      cannot be replayed.
#
# The forgot-password endpoint intentionally returns the same generic
# payload whether or not the email exists — this prevents attackers
# from enumerating registered dealers. Rate limiting also applies at
# the per-email level (max 3 requests per hour).
# ==================================================================


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


PASSWORD_RESET_TTL_SECONDS = 30 * 60          # 30 minutes
PASSWORD_RESET_MAX_PER_HOUR = 3               # per email
PASSWORD_RESET_TOKEN_TYPE = "pwreset"


def _app_base_url_from_request(request: Optional[Request]) -> str:
    """Resolve the customer-facing origin for building the reset link.
    Priority:
      1. `APP_BASE_URL` env var (explicit override, wins in production)
      2. `Origin` request header (works both in dev and preview)
      3. Fallback constant for local dev
    """
    env_url = (os.environ.get("APP_BASE_URL") or "").strip().rstrip("/")
    if env_url:
        return env_url
    if request is not None:
        origin = request.headers.get("origin") or request.headers.get("referer")
        if origin:
            # Strip everything after the host if it's a full URL.
            m = re.match(r"^(https?://[^/]+)", origin)
            if m:
                return m.group(1)
    return "http://localhost:3000"


async def _send_password_reset_email(
    to_email: str, reset_link: str, display_name: Optional[str] = None
) -> None:
    """Fire-and-forget dispatch of the reset email via the Emergent-
    managed Resend proxy. Failures are logged but do not raise — the
    caller's response must be identical regardless (to avoid email
    enumeration)."""
    email_key = (os.environ.get("EMERGENT_EMAIL_KEY") or "").strip()
    from_name = (os.environ.get("EMAIL_FROM_NAME") or "TRADE AI powered by FOURBUY").strip()
    if not email_key:
        logger.error("EMERGENT_EMAIL_KEY not configured — cannot send reset email")
        return

    greeting = f"Hi {display_name}," if display_name else "Hi,"
    html = f"""
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0F14;padding:32px 0;font-family:Arial,Helvetica,sans-serif;color:#E5E7EB;">
      <tr>
        <td align="center">
          <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#111827;border:1px solid #1F2937;border-radius:14px;padding:32px;">
            <tr>
              <td style="font-size:20px;font-weight:800;color:#F9FAFB;padding-bottom:8px;">Reset your Fourbuy password</td>
            </tr>
            <tr>
              <td style="font-size:14px;color:#D1D5DB;line-height:1.5;padding-bottom:20px;">
                {greeting}<br><br>
                We received a request to reset the password for your TRADE AI powered by FOURBUY account. Click the button below to choose a new one. This link is valid for 30 minutes and can only be used once.
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 0 20px 0;">
                <a href="{reset_link}"
                   style="display:inline-block;background:#F59E0B;color:#111827;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:800;letter-spacing:.3px;">
                  Reset password
                </a>
              </td>
            </tr>
            <tr>
              <td style="font-size:12px;color:#9CA3AF;line-height:1.5;">
                If the button doesn't work, copy and paste this link into your browser:<br>
                <span style="color:#93C5FD;word-break:break-all;">{reset_link}</span>
              </td>
            </tr>
            <tr>
              <td style="font-size:11px;color:#6B7280;padding-top:24px;border-top:1px solid #1F2937;margin-top:24px;">
                Didn't ask for this? You can safely ignore this email — your current password will keep working.
              </td>
            </tr>
          </table>
          <div style="font-size:11px;color:#6B7280;padding-top:16px;">
            © TRADE AI powered by FOURBUY
          </div>
        </td>
      </tr>
    </table>
    """
    payload = {
        "to": [to_email],
        "subject": "Reset your Fourbuy password",
        "html": html,
        "from_name": from_name,
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                "https://integrations.emergentagent.com/api/v1/email/send",
                headers={"X-Email-Key": email_key},
                json=payload,
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        logger.error(
            "Password-reset email send failed: status=%s body=%s",
            e.response.status_code, e.response.text[:400],
        )
    except Exception as e:
        logger.error("Password-reset email send error: %s", e)


@router.post("/auth/forgot-password")
async def forgot_password(payload: ForgotPasswordRequest, request: Request):
    """Kick off a password-reset flow. Always returns the same generic
    payload so callers can't enumerate which emails are registered."""
    generic = {
        "status": "ok",
        "message": "If that email is registered, a reset link has been sent.",
    }
    email = payload.email.lower().strip()
    if not email:
        return generic

    # Rate-limit: max PASSWORD_RESET_MAX_PER_HOUR requests per email in
    # the last hour. Silently swallow anything over-limit — again to
    # avoid revealing whether the account exists.
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    recent_count = await db.password_resets.count_documents({
        "email": email, "created_at": {"$gte": cutoff.isoformat()},
    })
    if recent_count >= PASSWORD_RESET_MAX_PER_HOUR:
        logger.info("Password-reset rate-limited for %s (%d in last hour)", email, recent_count)
        return generic

    user = await db.users.find_one(
        {"email": email},
        {"_id": 0, "id": 1, "email": 1, "role": 1, "dealer_info": 1, "active": 1, "archived_at": 1},
    )

    if user and not user.get("archived_at"):
        # Suspended dealers can still reset — resetting itself doesn't
        # bypass any suspension check, and support may deliberately ask
        # them to reset before we lift a suspension.
        jti = _pw_secrets.token_urlsafe(24)
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(seconds=PASSWORD_RESET_TTL_SECONDS)
        token_body = {
            "sub": user["id"],
            "email": user["email"],
            "type": PASSWORD_RESET_TOKEN_TYPE,
            "jti": jti,
            "iat": int(now.timestamp()),
            "exp": int(expires_at.timestamp()),
        }
        token = pyjwt.encode(token_body, JWT_SECRET, algorithm="HS256")
        await db.password_resets.insert_one({
            "jti": jti,
            "user_id": user["id"],
            "email": email,
            "created_at": now.isoformat(),
            "expires_at": expires_at.isoformat(),
            "consumed_at": None,
            "request_ip": request.client.host if request and request.client else None,
        })
        base = _app_base_url_from_request(request)
        # `/reset-password?token=...` — file lives at
        # /app/frontend/app/(auth)/reset-password.tsx (the auth group
        # is a routing convenience, the URL doesn't include it).
        reset_link = f"{base}/reset-password?token={token}"
        logger.info("reset_link built: %s", reset_link)

        # Best-effort personalisation.
        info = user.get("dealer_info") or {}
        display_name = (info.get("first_name") or "").strip() or None
        await _send_password_reset_email(user["email"], reset_link, display_name=display_name)
        logger.info("Password reset email dispatched to %s (jti=%s)", email, jti)
    else:
        # Log-only — do NOT reveal to the caller that the user is missing.
        logger.info("Password reset requested for unknown email: %s", email)

    return generic


@router.post("/auth/reset-password")
async def reset_password(payload: ResetPasswordRequest):
    """Consume a reset token and set the new password. Enforces:
      • JWT signature + type + expiry
      • jti has not already been consumed (single-use)
      • Minimum password length (6 chars, matches /auth/register)
    """
    new_password = (payload.new_password or "").strip()
    if len(new_password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters.")
    try:
        decoded = pyjwt.decode(payload.token, JWT_SECRET, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(400, "This reset link has expired. Please request a new one.")
    except pyjwt.InvalidTokenError:
        raise HTTPException(400, "This reset link is invalid. Please request a new one.")

    if decoded.get("type") != PASSWORD_RESET_TOKEN_TYPE:
        raise HTTPException(400, "This reset link is invalid.")

    jti = decoded.get("jti")
    user_id = decoded.get("sub")
    if not jti or not user_id:
        raise HTTPException(400, "This reset link is invalid.")

    record = await db.password_resets.find_one({"jti": jti})
    if not record:
        raise HTTPException(400, "This reset link is invalid.")
    if record.get("consumed_at"):
        raise HTTPException(400, "This reset link has already been used. Please request a new one.")

    user = await db.users.find_one({"id": user_id}, {"_id": 0, "id": 1, "email": 1})
    if not user:
        raise HTTPException(400, "Account no longer exists.")

    # Atomically mark the jti consumed BEFORE writing the new hash so a
    # race between two clicks can't set two different passwords.
    consumed = await db.password_resets.update_one(
        {"jti": jti, "consumed_at": None},
        {"$set": {"consumed_at": datetime.now(timezone.utc).isoformat()}},
    )
    if consumed.modified_count != 1:
        raise HTTPException(400, "This reset link has already been used. Please request a new one.")

    new_hash = hash_password(new_password)
    await db.users.update_one(
        {"id": user_id},
        {"$set": {
            "password_hash": new_hash,
            # Legacy field kept in sync (some older code still reads it).
            "password_hashed": new_hash,
            # Reset lockout state so a locked account can log in again
            # immediately after a successful reset.
            "failed_login_count": 0,
            "account_locked_until": None,
            "password_updated_at": datetime.now(timezone.utc).isoformat(),
        }},
    )

    return {"status": "ok", "message": "Password updated. You can now sign in."}


@router.get("/auth/me")
async def me(current: dict = Depends(get_current_user)):
    # Include billing-related fields that the client uses to gate flows.
    current["active"] = current.get("active", True)
    # Lazily assign a lifetime referral code to any dealer that doesn't
    # already have one (covers users created before referral codes were
    # introduced). Admins do NOT get a code — referrals are dealer-only.
    if current.get("role") == "dealer" and not current.get("referral_code"):
        async def _code_exists(c: str) -> bool:
            return (await db.users.count_documents({"referral_code": c})) > 0
        code = await allocate_unique_code(_code_exists)
        await db.users.update_one({"id": current["id"]}, {"$set": {"referral_code": code}})
        current["referral_code"] = code
    # Enrich with dealership info so the client can render "Submitted by
    # …" chips and a "Team" screen without a second round-trip.
    if current.get("role") == "dealer":
        dealership_id = await _get_user_dealership_id(current)
        if dealership_id:
            current["dealership_id"] = dealership_id
            dship = await db.dealerships.find_one({"id": dealership_id}, {"_id": 0})
            if dship:
                current["dealership"] = dship
        # Attach a friendly "referred_by" payload so the Profile screen can
        # render a "Referred by …" line without a second round-trip. We only
        # expose safe fields (name + dealership) — never id/email/phone.
        rb_id = current.get("referred_by_user_id")
        if rb_id:
            referrer = await db.users.find_one(
                {"id": rb_id},
                {"_id": 0, "dealer_info": 1, "dealership_id": 1, "referral_code": 1},
            )
            if referrer:
                info = referrer.get("dealer_info") or {}
                first = (info.get("first_name") or "").strip()
                last = (info.get("last_name") or "").strip()
                name = (first + " " + last).strip() or "a Fourbuy dealer"
                rb_dship_name = None
                if referrer.get("dealership_id"):
                    rdship = await db.dealerships.find_one(
                        {"id": referrer["dealership_id"]}, {"_id": 0, "name": 1}
                    )
                    rb_dship_name = (rdship or {}).get("name")
                current["referred_by"] = {
                    "name": name,
                    "dealership": rb_dship_name,
                    "code": current.get("referred_by_code") or referrer.get("referral_code"),
                }
    current["is_pricing_agent"] = bool(current.get("is_pricing_agent"))
    return {"user": current}


@router.get("/referral/lookup")
async def referral_lookup(code: str):
    """PUBLIC endpoint — no auth required. Given a referral code, return
    a minimal safe payload the register/invitation screen can use to
    render "Referred by <name>" for a prospective dealer arriving via a
    shared link. Returns 404 for unknown codes."""
    normalised = (code or "").strip().upper()
    if not normalised:
        raise HTTPException(400, "Referral code required.")
    user = await db.users.find_one(
        {"referral_code": normalised, "role": "dealer"},
        {"_id": 0, "id": 1, "dealer_info": 1, "dealership_id": 1},
    )
    if not user:
        raise HTTPException(404, "Referral code not found.")
    dship = None
    if user.get("dealership_id"):
        dship = await db.dealerships.find_one(
            {"id": user["dealership_id"]}, {"_id": 0, "name": 1}
        )
    info = user.get("dealer_info") or {}
    first = (info.get("first_name") or "").strip()
    last = (info.get("last_name") or "").strip()
    name = (first + " " + last).strip() or "a Fourbuy dealer"
    return {
        "code": normalised,
        "referrer_name": name,
        "referrer_first_name": first or None,
        "referrer_dealership": (dship or {}).get("name"),
    }


class SelfProfileUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    job_title: Optional[str] = None


@router.patch("/auth/me")
async def update_me(
    payload: SelfProfileUpdate,  # noqa: ARG001 - kept for schema compatibility
    current: dict = Depends(get_current_user),
):
    """Self-service profile editing is disabled.

    Dealer profile fields (name, phone, job title, etc.) must be maintained
    by a Fourbuy admin from Manage Dealers so that role, job title and
    contact details are auditable. This endpoint returns 403 for every
    caller to keep the client contract explicit.
    """
    _ = current  # touch to silence unused-var
    raise HTTPException(
        status_code=403,
        detail=(
            "Profile edits are managed by Fourbuy administrators. "
            "Please contact your Fourbuy admin to update your details."
        ),
    )


__all__ = ["router"]
