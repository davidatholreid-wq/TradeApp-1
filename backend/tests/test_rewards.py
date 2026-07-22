"""
Backend tests for Fourbuy Rewards system.

Covers:
- GET /api/rewards/me shape
- Award idempotency on /admin/submissions/{id}/price
- No award when submission priced outside 24h SLA
- POST /api/rewards/redeem (insufficient balance and successful redemption)
- GET /api/admin/reward-redemptions (list + filter by status)
- POST /api/admin/reward-redemptions/{id}/fulfill (and double-fulfill guard)
- POST /api/admin/reward-redemptions/{id}/reject (points refunded)
"""
import os
import uuid
import base64
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient
import asyncio

# Load /app/backend/.env before reading MONGO_URL/DB_NAME so that direct
# mongo helpers hit the SAME database as the FastAPI server. Without this,
# pytest inherits only shell env and DB_NAME falls back to a wrong default,
# so seeded ledger rows never show up via /rewards/me.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except Exception:
    pass

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "autopricepro_db")

# Registration is INVITATION-ONLY as of the SA ID / referral rollout — new
# dealers must be created by an admin via POST /api/admin/dealerships/{id}/users.
# We create rewards test dealers into Ford Bryanston, which is preserved in every
# environment cleanup as a "core" dealership.
FORD_BRYANSTON_ID = os.environ.get("REWARDS_TEST_DEALERSHIP_ID", "5b5cd0c6-3f06-45c4-8067-52c40f0c92bf")

# Known-good SA IDs (13-digit + valid DOB + Luhn) — same values used across
# the referral test suite. Uniqueness is not enforced on sa_id_number in the
# backend, so we can safely reuse a single valid ID for many disposable dealers.
SA_ID_VALID = "9202204720083"  # 1992-02-20, Luhn ok


# ---------- Fixtures ----------
@pytest.fixture(scope="session")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="session")
def admin_token(s):
    r = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    data = r.json()
    assert data["user"]["role"] == "admin"
    return data["token"]


def _register_dealer(s, admin_token):
    """Create a fresh dealer via the admin invitation endpoint and log them in.

    Public /api/auth/register is intentionally disabled (returns 403) because
    Fourbuy is invitation-only, so tests must go through the admin flow.
    """
    email = f"test_rewards_{uuid.uuid4().hex[:8]}@example.com"
    password = "Rewards123!"
    payload = {
        "email": email,
        "password": password,
        "dealer_info": {
            "first_name": "Rew",
            "last_name": "Tester",
            "phone": "0821234567",
        },
        "active": True,
        "sa_id_number": SA_ID_VALID,
    }
    r = s.post(
        f"{API}/admin/dealerships/{FORD_BRYANSTON_ID}/users",
        json=payload,
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert r.status_code == 200, f"Admin invite failed: {r.status_code} {r.text}"
    user = r.json()["user"]
    # Log the new dealer in to get their own token.
    lr = s.post(f"{API}/auth/login", json={"email": email, "password": password})
    assert lr.status_code == 200, f"Dealer login failed: {lr.status_code} {lr.text}"
    return {"token": lr.json()["token"], "user_id": user["id"], "email": email, "password": password}


@pytest.fixture(scope="session")
def dealer_a(s, admin_token):
    return _register_dealer(s, admin_token)


@pytest.fixture(scope="session")
def dealer_b(s, admin_token):
    return _register_dealer(s, admin_token)


def _tiny_b64():
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="


def _submit_vehicle(s, dealer):
    # Accept agreement first (409 blocker otherwise)
    try:
        s.post(f"{API}/agreement/accept",
               headers={"Authorization": f"Bearer {dealer['token']}"})
    except Exception:
        pass
    makes = s.get(f"{API}/vehicles/makes").json()["makes"]
    toyota = next(m for m in makes if m["name"] == "Toyota")
    models = s.get(f"{API}/vehicles/models", params={"make_id": toyota["id"]}).json()["models"]
    hilux = next(m for m in models if m["name"] == "Hilux")
    derivs = s.get(f"{API}/vehicles/derivatives", params={"model_id": hilux["id"]}).json()["derivatives"]
    deriv = derivs[0]
    photo = _tiny_b64()
    payload = {
        # ID + display fields
        "make_id": toyota["id"], "make_name": "Toyota",
        "model_id": hilux["id"], "model_name": "Hilux",
        "derivative_id": deriv["id"], "derivative_name": deriv["name"],
        # Required scalar vehicle fields (new schema)
        "make": "Toyota", "model": "Hilux", "derivative": deriv["name"],
        "fuel_type": "Diesel", "transmission": "Manual",
        "year_of_production": 2020, "year_registered": 2020,
        "mileage": 55000,
        "colour": "White",
        # Four pillars
        "mechanical_condition": 8, "cosmetic_condition": 8,
        "interior_condition": 8, "history_condition": 8,
        "windscreen_condition": "Perfect",
        "service_history": "Full Service History with Agents",
        "paint_evidence": False,
        "accident_damage": False,
        "factory_warranty": True,
        "license_disk_data": "%TEST%LICENSE_DISK%DATA%",
        "photos": {
            "front": photo, "driver_side": photo, "passenger_side": photo,
            "rear": photo, "interior": photo,
        },
        "billing_accepted": True,
    }
    r = s.post(f"{API}/submissions", json=payload,
               headers={"Authorization": f"Bearer {dealer['token']}"})
    assert r.status_code == 200, f"Submission failed: {r.text}"
    return r.json()["id"]


# ---------- Mongo helpers for direct DB manipulation ----------
def _run_async(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


async def _mongo():
    client = AsyncIOMotorClient(MONGO_URL)
    return client, client[DB_NAME]


def _push_submission_back(sub_id: str, hours: int = 48):
    async def _do():
        client, db = await _mongo()
        try:
            new_created = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
            await db.submissions.update_one({"id": sub_id}, {"$set": {"created_at": new_created}})
        finally:
            client.close()
    _run_async(_do())


def _seed_ledger_earn(user_id: str, count: int):
    async def _do():
        client, db = await _mongo()
        try:
            docs = [{
                "id": str(uuid.uuid4()),
                "user_id": user_id,
                "type": "earn",
                "delta": 1,
                "sub_id": f"SEED-{uuid.uuid4().hex}",
                "note": "TEST seed earn",
                "at": datetime.now(timezone.utc).isoformat(),
            } for _ in range(count)]
            if docs:
                await db.reward_ledger.insert_many(docs)
        finally:
            client.close()
    _run_async(_do())


def _cleanup_ledger(user_id: str):
    async def _do():
        client, db = await _mongo()
        try:
            await db.reward_ledger.delete_many({"user_id": user_id})
            await db.reward_redemptions.delete_many({"user_id": user_id})
        finally:
            client.close()
    _run_async(_do())


# ---------- Tests ----------
class TestRewardsMeShape:
    """GET /api/rewards/me — shape validation on a fresh dealer."""

    def test_shape_zero_balance(self, s, dealer_a):
        r = s.get(f"{API}/rewards/me",
                  headers={"Authorization": f"Bearer {dealer_a['token']}"})
        assert r.status_code == 200, r.text
        d = r.json()
        # Required top-level keys
        for k in ["label", "balance", "points_per_voucher", "voucher_value_zar",
                  "voucher_provider", "can_redeem", "points_to_next_voucher",
                  "totals", "ledger", "redemptions"]:
            assert k in d, f"missing key {k}"
        assert isinstance(d["balance"], int) and d["balance"] >= 0
        assert d["points_per_voucher"] == 50
        assert d["voucher_value_zar"] == 500
        assert d["voucher_provider"] == "Takealot"
        assert d["can_redeem"] is False
        assert d["points_to_next_voucher"] == 50
        # totals must include earned/spent/refunded (referred was added later by the referral feature)
        for k in ("earned", "spent", "refunded"):
            assert d["totals"].get(k) == 0, f"totals.{k} should be 0, got {d['totals'].get(k)}"
        assert d["ledger"] == []
        assert d["redemptions"] == []
        # No _id leaks
        assert "_id" not in d

    def test_admin_cannot_access_rewards_me(self, s, admin_token):
        r = s.get(f"{API}/rewards/me", headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 400


class TestAwardIdempotency:
    """Pricing a submission awards 1 point; re-pricing does NOT double-award."""

    def test_award_on_price_within_sla_then_idempotent(self, s, admin_token, dealer_b):
        sub_id = _submit_vehicle(s, dealer_b)
        # First pricing → award
        r = s.post(f"{API}/admin/submissions/{sub_id}/price",
                   json={"price": 150000, "notes": "TEST"},
                   headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200, r.text
        # Verify balance == 1
        r2 = s.get(f"{API}/rewards/me",
                   headers={"Authorization": f"Bearer {dealer_b['token']}"})
        assert r2.status_code == 200
        d = r2.json()
        assert d["balance"] == 1, f"expected balance 1, got {d['balance']}"
        assert d["totals"]["earned"] == 1
        # Re-price the same submission → still 1 (idempotent via sub_id)
        r3 = s.post(f"{API}/admin/submissions/{sub_id}/price",
                    json={"price": 160000, "notes": "TEST bump"},
                    headers={"Authorization": f"Bearer {admin_token}"})
        assert r3.status_code == 200
        r4 = s.get(f"{API}/rewards/me",
                   headers={"Authorization": f"Bearer {dealer_b['token']}"})
        d4 = r4.json()
        assert d4["balance"] == 1, f"idempotency broken — balance became {d4['balance']}"
        assert d4["totals"]["earned"] == 1
        # And exactly ONE 'earn' ledger row for this sub_id.
        earn_rows = [e for e in d4["ledger"] if e["type"] == "earn"]
        assert len(earn_rows) == 1


class TestSlaAwardGuard:
    """No point awarded if the submission is priced OUTSIDE the 24h SLA."""

    def test_no_award_when_outside_sla(self, s, admin_token):
        dealer = _register_dealer(s, admin_token)
        sub_id = _submit_vehicle(s, dealer)
        # Push created_at back 48h so it becomes outside SLA
        _push_submission_back(sub_id, hours=48)
        # Now price it
        r = s.post(f"{API}/admin/submissions/{sub_id}/price",
                   json={"price": 100000, "notes": "TEST outside SLA"},
                   headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200, r.text
        r2 = s.get(f"{API}/rewards/me",
                   headers={"Authorization": f"Bearer {dealer['token']}"})
        d = r2.json()
        assert d["balance"] == 0, f"expected 0 (out of SLA), got {d['balance']}"
        assert d["totals"]["earned"] == 0
        # Cleanup
        _cleanup_ledger(dealer["user_id"])


class TestRedeem:
    """POST /api/rewards/redeem — insufficient + successful redemption."""

    def test_redeem_insufficient_400(self, s, admin_token):
        dealer = _register_dealer(s, admin_token)
        r = s.post(f"{API}/rewards/redeem",
                   json={"desired_email": dealer["email"]},
                   headers={"Authorization": f"Bearer {dealer['token']}"})
        assert r.status_code == 400
        assert "enough" in (r.json().get("detail") or "").lower() or "50" in (r.json().get("detail") or "")

    def test_redeem_success_deducts_points_and_creates_pending(self, s, admin_token):
        dealer = _register_dealer(s, admin_token)
        # Seed 50 earn entries for this dealer directly in mongo
        _seed_ledger_earn(dealer["user_id"], 50)
        # Verify balance == 50 via API
        me = s.get(f"{API}/rewards/me",
                   headers={"Authorization": f"Bearer {dealer['token']}"}).json()
        assert me["balance"] == 50
        assert me["can_redeem"] is True
        # Redeem with a custom email
        target_email = f"voucher_{uuid.uuid4().hex[:6]}@example.com"
        r = s.post(f"{API}/rewards/redeem",
                   json={"desired_email": target_email},
                   headers={"Authorization": f"Bearer {dealer['token']}"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["balance"] == 0
        redemption = d["redemption"]
        assert redemption["status"] == "pending"
        assert redemption["voucher_value_zar"] == 500
        assert redemption["points_cost"] == 50
        assert redemption["requested_email"] == target_email
        assert redemption["voucher_code"] in (None, "")
        # And GET /rewards/me shows it
        me2 = s.get(f"{API}/rewards/me",
                    headers={"Authorization": f"Bearer {dealer['token']}"}).json()
        assert me2["balance"] == 0
        assert len(me2["redemptions"]) == 1
        assert me2["redemptions"][0]["id"] == redemption["id"]
        assert me2["totals"]["spent"] == 50
        # Cleanup
        _cleanup_ledger(dealer["user_id"])

    def test_redeem_defaults_email_to_login_email(self, s, admin_token):
        dealer = _register_dealer(s, admin_token)
        _seed_ledger_earn(dealer["user_id"], 50)
        # Omit desired_email → should fallback to login email
        r = s.post(f"{API}/rewards/redeem",
                   json={},
                   headers={"Authorization": f"Bearer {dealer['token']}"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["redemption"]["requested_email"] == dealer["email"].lower()
        _cleanup_ledger(dealer["user_id"])


class TestAdminInboxAndActions:
    """Admin list / fulfil / reject."""

    def _seed_pending(self, s, admin_token):
        dealer = _register_dealer(s, admin_token)
        _seed_ledger_earn(dealer["user_id"], 50)
        r = s.post(f"{API}/rewards/redeem", json={"desired_email": dealer["email"]},
                   headers={"Authorization": f"Bearer {dealer['token']}"})
        assert r.status_code == 200
        return dealer, r.json()["redemption"]["id"]

    def test_admin_list_all_and_filter_pending(self, s, admin_token):
        dealer, redemption_id = self._seed_pending(s, admin_token)
        # List all
        r = s.get(f"{API}/admin/reward-redemptions",
                  headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200
        d = r.json()
        assert "redemptions" in d
        assert "pending_count" in d
        assert isinstance(d["pending_count"], int)
        ids = [x["id"] for x in d["redemptions"]]
        assert redemption_id in ids
        # No _id leak
        for row in d["redemptions"]:
            assert "_id" not in row

        # Filter status=pending
        r2 = s.get(f"{API}/admin/reward-redemptions", params={"status": "pending"},
                   headers={"Authorization": f"Bearer {admin_token}"})
        assert r2.status_code == 200
        d2 = r2.json()
        for row in d2["redemptions"]:
            assert row["status"] == "pending"

        # Filter status=fulfilled — should NOT contain our new pending one
        r3 = s.get(f"{API}/admin/reward-redemptions", params={"status": "fulfilled"},
                   headers={"Authorization": f"Bearer {admin_token}"})
        assert r3.status_code == 200
        assert redemption_id not in [x["id"] for x in r3.json()["redemptions"]]

        _cleanup_ledger(dealer["user_id"])

    def test_fulfill_marks_and_no_balance_change_plus_double_fulfill_blocked(self, s, admin_token):
        dealer, redemption_id = self._seed_pending(s, admin_token)
        # Balance is 0 already (points spent at redeem)
        pre = s.get(f"{API}/rewards/me",
                    headers={"Authorization": f"Bearer {dealer['token']}"}).json()
        assert pre["balance"] == 0

        r = s.post(f"{API}/admin/reward-redemptions/{redemption_id}/fulfill",
                   json={"voucher_code": "TAKEALOT-1234-5678", "admin_note": "sent"},
                   headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200, r.text
        d = r.json()["redemption"]
        assert d["status"] == "fulfilled"
        assert d["voucher_code"] == "TAKEALOT-1234-5678"
        assert d["admin_note"] == "sent"
        assert d["actioned_by_admin_id"]
        assert d["actioned_at"]

        # Balance unchanged
        post = s.get(f"{API}/rewards/me",
                     headers={"Authorization": f"Bearer {dealer['token']}"}).json()
        assert post["balance"] == 0

        # Fulfil ledger row inserted (delta=0)
        fulfill_rows = [e for e in post["ledger"] if e["type"] == "fulfill"]
        assert len(fulfill_rows) >= 1
        assert all(e["delta"] == 0 for e in fulfill_rows)

        # Double fulfil should 400
        r2 = s.post(f"{API}/admin/reward-redemptions/{redemption_id}/fulfill",
                    json={"voucher_code": "OTHER-CODE", "admin_note": "again"},
                    headers={"Authorization": f"Bearer {admin_token}"})
        assert r2.status_code == 400

        _cleanup_ledger(dealer["user_id"])

    def test_reject_refunds_points(self, s, admin_token):
        dealer, redemption_id = self._seed_pending(s, admin_token)
        pre = s.get(f"{API}/rewards/me",
                    headers={"Authorization": f"Bearer {dealer['token']}"}).json()
        assert pre["balance"] == 0

        r = s.post(f"{API}/admin/reward-redemptions/{redemption_id}/reject",
                   json={"admin_note": "unable to source"},
                   headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200, r.text
        d = r.json()["redemption"]
        assert d["status"] == "rejected"
        assert d["admin_note"] == "unable to source"

        # Balance refunded → 50
        post = s.get(f"{API}/rewards/me",
                     headers={"Authorization": f"Bearer {dealer['token']}"}).json()
        assert post["balance"] == 50
        assert post["totals"]["refunded"] == 50

        # Rejecting again should 400
        r2 = s.post(f"{API}/admin/reward-redemptions/{redemption_id}/reject",
                    json={"admin_note": "again"},
                    headers={"Authorization": f"Bearer {admin_token}"})
        assert r2.status_code == 400

        _cleanup_ledger(dealer["user_id"])


class TestRbac:
    def test_dealer_cannot_list_admin_redemptions(self, s, dealer_a):
        r = s.get(f"{API}/admin/reward-redemptions",
                  headers={"Authorization": f"Bearer {dealer_a['token']}"})
        assert r.status_code == 403

    def test_no_token_rewards_me_401(self, s):
        r = s.get(f"{API}/rewards/me")
        assert r.status_code == 401
