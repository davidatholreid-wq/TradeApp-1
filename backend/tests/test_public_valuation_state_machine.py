"""Backend regression tests for the Public Valuation Portal admin
state-machine + Kredo integration (iteration_53).

Focus:
  1. bucket=priced EXCLUDES rows with a non-null delivered_*_at
  2. bucket=delivered MATCHES rows with delivered_email_at OR delivered_whatsapp_at
  3. bucket=pending returns only status=pending
  4. POST /price on an already-delivered lead:
       - updates price/priced_at/status
       - CLEARS delivered_*_at + last_whatsapp_message + last_email_*
  5. After re-price, the lead reappears in bucket=priced and disappears
     from bucket=delivered.
  6. POST /market-values:
       - requires admin JWT (401 when anonymous)
       - 400 when make/model/year missing
       - 200 (persists market_values on the submission) or 502 if Kredo
         upstream unavailable — both accepted per spec
"""
from __future__ import annotations

import os
import uuid

import pytest
import requests

BASE_URL = (
    os.environ.get("EXPO_BACKEND_URL")
    or os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or ""
).rstrip("/")
assert BASE_URL, "EXPO_BACKEND_URL / EXPO_PUBLIC_BACKEND_URL must be set"
API = f"{BASE_URL}/api"

BYPASS_TOKEN = "ci-test-bypass-fourbuy-2026"
TINY_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII="
)
PHOTOS = {s: TINY_PNG for s in ("front", "rear", "left", "right", "interior", "dash")}


# ---------- Fixtures ----------
@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(
        f"{API}/auth/login",
        json={"email": "admin@fourbuy.co.za", "password": "admin123"},
        timeout=30,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return {"Authorization": f"Bearer {r.json()['token']}"}


def _rand_octet():
    return uuid.uuid4().int % 250 + 1


def _fresh_ip():
    return f"172.31.{_rand_octet()}.{_rand_octet()}"


def _digits_tail(n: int = 7) -> str:
    """Random digit-only phone tail so `_normalise_phone` produces a valid
    E.164 (mixing hex letters would fail the 8-char minimum check)."""
    return f"{uuid.uuid4().int % 10_000_000:07d}"


def _submission_payload(phone_tail: str):
    return {
        "seller": {
            "full_name": "State Machine Tester",
            "phone": f"082{phone_tail}",
            "email": f"sm_{uuid.uuid4().hex[:8]}@example.com",
            "consent_accepted": True,
        },
        "vehicle": {
            "year_of_production": 2019,
            "year_registered": 2020,
            "year": 2020,
            "make": "BMW",
            "model": "3 Series",
            "derivative": "320i M Sport",
            "mileage": 85000,
            "fuel_type": "Petrol",
            "transmission": "Automatic",
        },
        "condition": {
            "overall": "Good",
            "accident_damage": False,
            "service_history": "Full",
        },
        "photos": PHOTOS,
        "turnstile_token": BYPASS_TOKEN,
        "utm_source": "pytest_state_machine",
    }


def _create_submission(phone_tail: str):
    payload = _submission_payload(phone_tail)
    r = requests.post(
        f"{API}/public/valuation",
        json=payload,
        headers={"Content-Type": "application/json", "X-Forwarded-For": _fresh_ip()},
        timeout=45,
    )
    assert r.status_code == 200, f"create failed: {r.status_code} {r.text}"
    return r.json()["reference"]


def _list_bucket(headers, bucket: str):
    r = requests.get(
        f"{API}/admin/public-submissions",
        params={"bucket": bucket},
        headers=headers,
        timeout=30,
    )
    assert r.status_code == 200, f"list {bucket}: {r.status_code} {r.text}"
    return r.json()["submissions"]


def _get(headers, ref):
    r = requests.get(f"{API}/admin/public-submissions/{ref}", headers=headers, timeout=30)
    assert r.status_code == 200, f"get {ref}: {r.status_code} {r.text}"
    return r.json()["submission"]


# ---------- Test: bucket=pending ----------
class TestBuckets:
    def test_pending_only_status_pending(self, admin_headers):
        ref = _create_submission(_digits_tail())
        subs = _list_bucket(admin_headers, "pending")
        # every row in pending must be status=pending, and our ref must be in it
        assert any(s["reference"] == ref for s in subs), "new submission not in pending bucket"
        for s in subs:
            assert s["status"] == "pending", f"non-pending in pending bucket: {s['reference']}"

    def test_priced_bucket_excludes_delivered(self, admin_headers):
        """priced bucket must EXCLUDE rows with either delivered_*_at set."""
        priced = _list_bucket(admin_headers, "priced")
        for s in priced:
            assert s["status"] == "priced"
            assert s.get("delivered_email_at") is None, (
                f"{s['reference']} has delivered_email_at but is in priced bucket"
            )
            assert s.get("delivered_whatsapp_at") is None, (
                f"{s['reference']} has delivered_whatsapp_at but is in priced bucket"
            )

    def test_delivered_bucket_only_delivered(self, admin_headers):
        """delivered bucket must ONLY contain rows with a non-null delivered_*_at."""
        delivered = _list_bucket(admin_headers, "delivered")
        for s in delivered:
            has_email = s.get("delivered_email_at") is not None
            has_wa = s.get("delivered_whatsapp_at") is not None
            assert has_email or has_wa, (
                f"{s['reference']} in delivered bucket but both delivered_*_at are null"
            )


# ---------- Test: state-machine (price → deliver → re-price) ----------
class TestStateMachine:
    def test_reprice_after_delivery_resets_state(self, admin_headers):
        # 1. create fresh
        ref = _create_submission(_digits_tail())

        # 2. first price
        r = requests.post(
            f"{API}/admin/public-submissions/{ref}/price",
            headers=admin_headers,
            json={"price": 285000, "price_notes": "Initial price"},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "priced"

        # appears in priced silo
        priced_refs = [s["reference"] for s in _list_bucket(admin_headers, "priced")]
        assert ref in priced_refs

        # 3. deliver via both channels
        d = requests.post(
            f"{API}/admin/public-submissions/{ref}/deliver",
            headers=admin_headers,
            json={
                "whatsapp_message": "Hi, valuation ready: {{pdf_url}}",
                "email_subject": "Your Fourbuy valuation",
                "email_body": "Hi, please see attached.",
                "channels": ["whatsapp", "email"],
            },
            timeout=30,
        )
        assert d.status_code == 200, d.text
        assert d.json()["delivered"] is True

        # after delivery: NOT in priced, IS in delivered
        priced_refs = [s["reference"] for s in _list_bucket(admin_headers, "priced")]
        assert ref not in priced_refs, (
            f"{ref} still shows in priced bucket after delivery"
        )
        delivered_refs = [s["reference"] for s in _list_bucket(admin_headers, "delivered")]
        assert ref in delivered_refs, f"{ref} not in delivered bucket after deliver"

        # sanity: db row has the delivery fields populated
        sub_after_deliver = _get(admin_headers, ref)
        assert sub_after_deliver["delivered_whatsapp_at"] is not None
        assert sub_after_deliver["delivered_email_at"] is not None
        assert sub_after_deliver.get("last_whatsapp_message")
        assert sub_after_deliver.get("last_email_subject")

        # 4. RE-price with new price — the crucial state-machine transition
        r2 = requests.post(
            f"{API}/admin/public-submissions/{ref}/price",
            headers=admin_headers,
            json={"price": 300000, "price_notes": "Re-priced after delivery"},
            timeout=30,
        )
        assert r2.status_code == 200, r2.text
        assert r2.json()["status"] == "priced"

        # a) reappears in priced silo
        priced_refs = [s["reference"] for s in _list_bucket(admin_headers, "priced")]
        assert ref in priced_refs, f"{ref} did not return to priced bucket after re-price"

        # b) disappears from delivered silo
        delivered_refs = [s["reference"] for s in _list_bucket(admin_headers, "delivered")]
        assert ref not in delivered_refs, (
            f"{ref} still in delivered bucket after re-price — timestamps not cleared"
        )

        # c) delivery timestamps + canned message fields are CLEARED
        sub_after_reprice = _get(admin_headers, ref)
        assert sub_after_reprice["price"] == 300000
        assert sub_after_reprice["priced_at"] is not None
        assert sub_after_reprice["status"] == "priced"
        assert sub_after_reprice["delivered_email_at"] is None, "delivered_email_at not cleared"
        assert sub_after_reprice["delivered_whatsapp_at"] is None, "delivered_whatsapp_at not cleared"
        assert sub_after_reprice.get("last_whatsapp_message") is None, "last_whatsapp_message not cleared"
        assert sub_after_reprice.get("last_email_subject") is None, "last_email_subject not cleared"
        assert sub_after_reprice.get("last_email_body") is None, "last_email_body not cleared"


# ---------- Test: market-values (Kredo) ----------
class TestMarketValues:
    def test_market_values_requires_admin(self):
        # create submission first so we know the id exists
        # (anonymous call should fail auth before hitting the DB, but use a
        # plausible-looking id anyway)
        r = requests.post(
            f"{API}/admin/public-submissions/FB-P-000001/market-values",
            timeout=30,
        )
        assert r.status_code == 401, f"expected 401 anonymous, got {r.status_code} {r.text}"

    def test_market_values_400_when_vehicle_missing_fields(self, admin_headers):
        """Create a submission then wipe make/model/year to trigger the 400."""
        ref = _create_submission(_digits_tail())
        sub = _get(admin_headers, ref)
        sub_id = sub["id"]

        # Blank the vehicle fields directly in Mongo
        from motor.motor_asyncio import AsyncIOMotorClient
        from dotenv import load_dotenv
        import asyncio

        load_dotenv("/app/backend/.env")

        async def blank_vehicle():
            c = AsyncIOMotorClient(os.getenv("MONGO_URL"))
            db = c[os.getenv("DB_NAME")]
            await db.public_submissions.update_one(
                {"id": sub_id},
                {"$set": {"vehicle.make": "", "vehicle.model": "", "vehicle.year": None,
                          "vehicle.year_of_production": None}},
            )
            c.close()

        asyncio.run(blank_vehicle())

        r = requests.post(
            f"{API}/admin/public-submissions/{sub_id}/market-values",
            headers=admin_headers,
            timeout=30,
        )
        assert r.status_code == 400, f"expected 400, got {r.status_code} {r.text}"
        assert "make" in r.text.lower() or "model" in r.text.lower() or "year" in r.text.lower()

    def test_market_values_ok_or_502(self, admin_headers):
        """Happy path: a fully-specified submission — Kredo should either
        return values (persisted) or the endpoint should surface a 502."""
        ref = _create_submission(_digits_tail())
        sub = _get(admin_headers, ref)
        sub_id = sub["id"]

        r = requests.post(
            f"{API}/admin/public-submissions/{sub_id}/market-values",
            headers=admin_headers,
            timeout=90,
        )
        assert r.status_code in (200, 502), (
            f"expected 200 or 502 from Kredo, got {r.status_code} {r.text[:400]}"
        )
        if r.status_code == 200:
            body = r.json()
            assert "market_values" in body
            mv = body["market_values"]
            assert mv["status"] == "ok"
            assert mv.get("source") == "kredo_vehicle_values"
            assert "fetched_at" in mv
            # trade_price_zar / retail_price_zar may legitimately be None if
            # Kredo couldn't price the exact derivative, but the keys MUST
            # be present in the payload.
            assert "trade_price_zar" in mv
            assert "retail_price_zar" in mv

            # verify persistence
            sub_after = _get(admin_headers, ref)
            assert sub_after.get("market_values") is not None
            assert sub_after["market_values"]["status"] == "ok"
        else:
            # 502 is acceptable per spec — could be either our FastAPI
            # KredoAPIError mapping OR a preview-edge Bad Gateway if
            # Kredo took longer than the ingress timeout. Both count as
            # "Kredo unavailable" from the app's perspective.
            pass

    def test_market_values_404_for_unknown_id(self, admin_headers):
        r = requests.post(
            f"{API}/admin/public-submissions/FB-P-999999/market-values",
            headers=admin_headers,
            timeout=30,
        )
        assert r.status_code == 404
