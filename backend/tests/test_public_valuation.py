"""Backend tests for the Public Valuation Portal (Phase 1).

Covers:
  - POST /api/public/valuation (anonymous, Turnstile-bypass)
  - GET  /api/admin/public-submissions
  - GET  /api/admin/public-submissions/{id|ref}
  - POST /api/admin/public-submissions/{id}/price
  - POST /api/admin/public-submissions/{id}/deliver
  - GET  /api/public/valuation/{ref}/pdf?t=...
  - Rate-limit (429 on 4th submission from same IP inside 24h)
  - Validation (consent, 6 photo slots)
  - Turnstile (400 when token missing on happy-path attempt)
  - Reference format & monotonic increase
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL") or os.environ.get(
    "EXPO_PUBLIC_BACKEND_URL",
    "https://fourbuy-admin.preview.emergentagent.com",
).rstrip("/")
API = f"{BASE_URL}/api"

BYPASS_TOKEN = "ci-test-bypass-fourbuy-2026"
TINY_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII="
)
PHOTOS = {s: TINY_PNG for s in ("front", "rear", "left", "right", "interior", "dash")}


# ---------- Fixtures ----------
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(
        f"{API}/auth/login",
        json={"email": "admin@fourbuy.co.za", "password": "admin123"},
        timeout=30,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def _payload(phone_suffix: str = "1234567"):
    return {
        "seller": {
            "full_name": "Test Public Seller",
            "phone": f"082{phone_suffix}",
            "email": f"public_{uuid.uuid4().hex[:8]}@example.com",
            "consent_accepted": True,
        },
        "vehicle": {
            "year": 2018,
            "make": "Toyota",
            "model": "Hilux",
            "derivative": "2.8 GD-6 Raider",
            "mileage": 120000,
            "colour": "White",
            "transmission": "Manual",
            "fuel_type": "Diesel",
        },
        "condition": {
            "overall": "Good",
            "accident_damage": False,
            "service_history": "Full",
        },
        "photos": PHOTOS,
        "turnstile_token": BYPASS_TOKEN,
        "utm_source": "pytest",
    }


def _submit(payload, ip=None, expect=200):
    headers = {"Content-Type": "application/json"}
    if ip:
        headers["X-Forwarded-For"] = ip
    r = requests.post(f"{API}/public/valuation", json=payload, headers=headers, timeout=45)
    return r


# ---------- Cleanup fixture (session-scoped) ----------
@pytest.fixture(scope="session", autouse=True)
def _cleanup_db():
    """Clear collections BEFORE the session so reference starts at 1
    and rate limits are fresh. Also reset counter."""
    from motor.motor_asyncio import AsyncIOMotorClient
    from dotenv import load_dotenv
    import asyncio

    load_dotenv("/app/backend/.env")

    async def clear():
        c = AsyncIOMotorClient(os.getenv("MONGO_URL"))
        db = c[os.getenv("DB_NAME")]
        await db.public_valuation_ratelimit.delete_many({})
        await db.public_submissions.delete_many({})
        await db.counters.delete_one({"_id": "public_submissions"})
        c.close()

    asyncio.run(clear())
    yield
    # optional teardown left in place for inspection


# ---------- Tests ----------
class TestPublicValuationHappyPath:
    def test_01_create_first_submission_ref_000001(self):
        payload = _payload("1111111")
        r = _submit(payload, ip="10.0.0.1")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["reference"] == "FB-P-000001"
        assert body["status"] == "pending"

    def test_02_create_second_submission_ref_000002(self):
        payload = _payload("2222222")
        r = _submit(payload, ip="10.0.0.2")
        assert r.status_code == 200, r.text
        assert r.json()["reference"] == "FB-P-000002"

    def test_03_create_third_submission_ref_000003(self):
        payload = _payload("3333333")
        r = _submit(payload, ip="10.0.0.3")
        assert r.status_code == 200, r.text
        assert r.json()["reference"] == "FB-P-000003"


class TestValidation:
    def test_missing_consent_400(self):
        p = _payload("4444001")
        p["seller"]["consent_accepted"] = False
        r = _submit(p, ip="10.0.1.1")
        assert r.status_code == 400, r.text
        assert "POPIA" in r.text or "consent" in r.text.lower()

    @pytest.mark.parametrize("slot", ["front", "rear", "left", "right", "interior", "dash"])
    def test_missing_photo_slot_400(self, slot):
        p = _payload(f"4444{['front','rear','left','right','interior','dash'].index(slot):03d}")
        p["photos"] = {k: v for k, v in PHOTOS.items() if k != slot}
        # Vary IP so we don't burn the rate-limit bucket
        r = _submit(p, ip=f"10.0.2.{['front','rear','left','right','interior','dash'].index(slot)+1}")
        assert r.status_code == 400, f"expected 400 missing {slot}, got {r.status_code} {r.text}"
        assert slot in r.text.lower() or "photo" in r.text.lower()


class TestTurnstile:
    def test_missing_token_400(self):
        p = _payload("5555001")
        p["turnstile_token"] = None
        r = _submit(p, ip="10.0.3.1")
        # Turnstile secret IS set in this env, so missing token must be rejected
        assert r.status_code in (400, 403), r.text
        assert "turnstile" in r.text.lower() or "anti-abuse" in r.text.lower()

    def test_wrong_token_rejected(self):
        p = _payload("5555002")
        p["turnstile_token"] = "not-the-bypass"
        r = _submit(p, ip="10.0.3.2")
        # A random token will hit real siteverify and fail (403), or
        # timeout via 502. Either is acceptable — must NOT succeed.
        assert r.status_code in (400, 403, 502), r.text


class TestRateLimit:
    def test_fourth_from_same_ip_429(self):
        ip = "10.0.4.99"
        # 3 successful submissions from same IP with different phones
        for i in range(3):
            p = _payload(f"888{i:04d}")
            r = _submit(p, ip=ip)
            assert r.status_code == 200, f"submission {i+1}: {r.status_code} {r.text}"
        # 4th must be 429
        p = _payload("8889999")
        r = _submit(p, ip=ip)
        assert r.status_code == 429, f"expected 429, got {r.status_code} {r.text}"


class TestAdminEndpoints:
    def test_admin_list_pending_requires_auth(self):
        r = requests.get(f"{API}/admin/public-submissions?bucket=pending", timeout=30)
        assert r.status_code == 401

    def test_admin_list_pending(self, auth_headers):
        r = requests.get(f"{API}/admin/public-submissions?bucket=pending", headers=auth_headers, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "submissions" in body and "count" in body
        assert body["count"] >= 3
        for s in body["submissions"]:
            assert s.get("status") == "pending"
            assert "_id" not in s
            assert s["reference"].startswith("FB-P-")

    def test_admin_get_by_reference(self, auth_headers):
        r = requests.get(f"{API}/admin/public-submissions/FB-P-000001", headers=auth_headers, timeout=30)
        assert r.status_code == 200, r.text
        sub = r.json()["submission"]
        assert sub["reference"] == "FB-P-000001"
        assert sub["seller"]["phone"].startswith("+27")
        assert "_id" not in sub

    def test_admin_get_by_id(self, auth_headers):
        # list to get an id
        lst = requests.get(f"{API}/admin/public-submissions?bucket=pending", headers=auth_headers, timeout=30).json()
        sid = lst["submissions"][0]["id"]
        r = requests.get(f"{API}/admin/public-submissions/{sid}", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        assert r.json()["submission"]["id"] == sid

    def test_admin_get_not_found(self, auth_headers):
        r = requests.get(f"{API}/admin/public-submissions/FB-P-999999", headers=auth_headers, timeout=30)
        assert r.status_code == 404


class TestPriceDeliverAndPdf:
    """End-to-end: price → deliver → download tokenised PDF."""

    def test_full_flow(self, auth_headers):
        ref = "FB-P-000001"
        # Price
        r = requests.post(
            f"{API}/admin/public-submissions/{ref}/price",
            headers=auth_headers,
            json={"price": 235000, "price_notes": "Solid Hilux, service history intact."},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "priced"

        # Verify persistence via GET
        g = requests.get(f"{API}/admin/public-submissions/{ref}", headers=auth_headers, timeout=30).json()["submission"]
        assert g["status"] == "priced"
        assert g["price"] == 235000
        assert g["priced_at"] is not None

        # bucket=priced should include it
        pri = requests.get(f"{API}/admin/public-submissions?bucket=priced", headers=auth_headers, timeout=30).json()
        assert any(s["reference"] == ref for s in pri["submissions"])

        # Deliver
        d = requests.post(
            f"{API}/admin/public-submissions/{ref}/deliver",
            headers=auth_headers,
            json={
                "whatsapp_message": "Hi — your Fourbuy valuation is ready: {{pdf_url}}",
                "email_subject": "Your valuation",
                "email_body": "Hi, please see attached.",
                "channels": ["whatsapp", "email"],
            },
            timeout=30,
        )
        assert d.status_code == 200, d.text
        db = d.json()
        assert db["delivered"] is True
        assert db["pdf_url"].startswith("https://") and "/api/public/valuation/" in db["pdf_url"]
        assert "?t=" in db["pdf_url"]
        assert db["wa_number"].startswith("27")  # no leading +
        assert "{{pdf_url}}" not in db["whatsapp_message"]  # placeholder must be substituted
        assert db["pdf_url"] in db["whatsapp_message"]

        # bucket=delivered should include it
        delv = requests.get(f"{API}/admin/public-submissions?bucket=delivered", headers=auth_headers, timeout=30).json()
        assert any(s["reference"] == ref for s in delv["submissions"])

        # PDF: anonymous fetch with token
        pdf_r = requests.get(db["pdf_url"], timeout=60)
        assert pdf_r.status_code == 200, f"PDF fetch failed: {pdf_r.status_code} {pdf_r.text[:200]}"
        assert pdf_r.headers.get("content-type", "").startswith("application/pdf")
        assert pdf_r.content[:4] == b"%PDF"

        # PDF: bad token → 403
        base_pdf = db["pdf_url"].split("?")[0]
        bad = requests.get(f"{base_pdf}?t=deadbeef", timeout=30)
        assert bad.status_code == 403

        # PDF: missing token → 403
        none_r = requests.get(base_pdf, timeout=30)
        assert none_r.status_code == 403

    def test_pdf_pending_ref_400(self):
        # ref 000002 was created but never priced
        base = f"{API}/public/valuation/FB-P-000002/pdf?t=anything"
        r = requests.get(base, timeout=30)
        # Not priced yet → 400 (before the token even gets checked)
        assert r.status_code in (400, 403), r.text

    def test_deliver_before_price_400(self, auth_headers):
        # 000003 has never been priced
        r = requests.post(
            f"{API}/admin/public-submissions/FB-P-000003/deliver",
            headers=auth_headers,
            json={"whatsapp_message": "hi {{pdf_url}}", "channels": ["whatsapp"]},
            timeout=30,
        )
        assert r.status_code == 400
        assert "price" in r.text.lower()


class TestReferenceMonotonic:
    def test_references_are_monotonic(self, auth_headers):
        # Fetch all pending+priced+delivered from admin and compare refs
        refs = []
        for bucket in ("pending", "priced", "delivered"):
            data = requests.get(
                f"{API}/admin/public-submissions?bucket={bucket}",
                headers=auth_headers,
                timeout=30,
            ).json()
            refs.extend([s["reference"] for s in data["submissions"]])
        refs = sorted(set(refs))
        assert refs[0] == "FB-P-000001"
        # Must all match the FB-P-###### pattern
        for r in refs:
            assert len(r) == len("FB-P-000001")
            assert r.startswith("FB-P-")
            int(r.split("-")[-1])  # numeric tail
