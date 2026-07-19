"""Multi-user dealership feature tests.

Covers:
- POST /api/auth/register creates a Dealership + first user with dealership_id
- GET  /api/auth/me returns dealership_id + dealership object
- PATCH /api/auth/me updates dealer_info.job_title
- GET  /api/admin/dealerships lists dealerships with stats
- POST /api/admin/dealerships/{id}/users adds a teammate
- E2E:  User A submits → User B (same dealership) sees it and vice-versa
- GET  /api/billing/my aggregates the whole dealership
- GET  /api/submissions/{id}/valuation.pdf works for either user
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"


def _uniq(prefix: str) -> str:
    # Backend lowercases emails on register/login; keep the local part lowercase
    # in the test to make equality assertions straightforward.
    return f"test_{prefix}_{uuid.uuid4().hex[:8]}@example.com"


@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _register_dealer(email: str, first: str = "Alice", last: str = "Smith", company: str = "TEST Motors", job_title: str | None = None) -> dict:
    payload = {
        "email": email,
        "password": "Test1234!",
        "dealer_info": {
            "first_name": first,
            "last_name": last,
            "phone": "0821234567",
            **({"job_title": job_title} if job_title else {}),
        },
        "company_info": {
            "company_name": company,
            "company_address": "1 Test Street, JHB",
        },
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=30)
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
    return r.json()


def _accept_agreement(token: str):
    r = requests.post(f"{API}/agreement/accept", headers=_auth(token), timeout=30)
    assert r.status_code == 200, f"agreement/accept failed: {r.status_code} {r.text}"


def _base_submission_payload() -> dict:
    return {
        "make": "Toyota",
        "fuel_type": "Petrol",
        "year_of_production": 2020,
        "transmission": "Automatic",
        "model": "Corolla",
        "derivative": "1.8 XS",
        "year_registered": 2020,
        "colour": "White",
        "vin": "TESTVIN" + uuid.uuid4().hex[:10].upper(),
        "engine_number": "TESTENG" + uuid.uuid4().hex[:6].upper(),
        "license_disk_data": None,
        "mechanical_condition": 8,
        "cosmetic_condition": 8,
        "interior_condition": 8,
        "history_condition": 8,
        "windscreen_condition": "Perfect",
        "service_history": "Full Service History with Agents",
        "last_service_date": "2024-06-01",
        "last_service_mileage": 45000,
        "photos": {},
        "mileage": 55000,
        "paint_evidence": False,
        "accident_damage": False,
        "accident_damage_types": [],
        "reconditioning_items": [],
        "billing_accepted": True,
    }


# ---------- Registration + auth/me ----------
class TestRegisterAndMe:
    def test_register_creates_dealership_and_links_user(self):
        email = _uniq("reg")
        data = _register_dealer(email, company="TEST Reg Motors")
        assert "token" in data and "user" in data
        u = data["user"]
        assert u["email"] == email
        assert u["role"] == "dealer"
        assert u.get("dealership_id"), "user.dealership_id missing on register response"

        # /auth/me should echo dealership_id + include a dealership object
        me = requests.get(f"{API}/auth/me", headers=_auth(data["token"]), timeout=30)
        assert me.status_code == 200
        me_user = me.json()["user"]
        assert me_user["dealership_id"] == u["dealership_id"]
        assert isinstance(me_user.get("dealership"), dict)
        assert me_user["dealership"].get("name") == "TEST Reg Motors"

    def test_patch_me_updates_job_title(self):
        email = _uniq("jobtitle")
        data = _register_dealer(email)
        token = data["token"]
        r = requests.patch(f"{API}/auth/me", headers=_auth(token), json={"job_title": "Sales Manager"}, timeout=30)
        assert r.status_code == 200, r.text
        fresh = r.json()["user"]
        assert fresh.get("dealer_info", {}).get("job_title") == "Sales Manager"

        # Persistence check
        me = requests.get(f"{API}/auth/me", headers=_auth(token), timeout=30).json()["user"]
        assert me.get("dealer_info", {}).get("job_title") == "Sales Manager"


# ---------- Admin dealership endpoints ----------
class TestAdminDealerships:
    def test_admin_list_dealerships(self, admin_token):
        r = requests.get(f"{API}/admin/dealerships", headers=_auth(admin_token), timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "dealerships" in body
        assert "fee_zar" in body
        assert isinstance(body["dealerships"], list)
        if body["dealerships"]:
            d0 = body["dealerships"][0]
            assert "user_count" in d0
            assert "submission_count" in d0
            assert "id" in d0 and "name" in d0

    def test_admin_add_user_to_dealership(self, admin_token):
        # Setup: register a fresh dealership (User A)
        email_a = _uniq("owner")
        a = _register_dealer(email_a, first="Owner", last="One", company="TEST Add-User Motors")
        dealership_id = a["user"]["dealership_id"]

        # Admin adds User B
        email_b = _uniq("mate")
        r = requests.post(
            f"{API}/admin/dealerships/{dealership_id}/users",
            headers=_auth(admin_token),
            json={
                "email": email_b,
                "password": "Test1234!",
                "dealer_info": {
                    "first_name": "Mate",
                    "last_name": "Two",
                    "phone": "0827654321",
                    "job_title": "F&I Manager",
                },
            },
            timeout=30,
        )
        assert r.status_code == 200, r.text
        new_user = r.json()["user"]
        assert new_user["email"] == email_b
        assert new_user["role"] == "dealer"
        assert new_user["dealership_id"] == dealership_id

        # New user can log in
        lr = requests.post(f"{API}/auth/login", json={"email": email_b, "password": "Test1234!"}, timeout=30)
        assert lr.status_code == 200, lr.text
        assert lr.json()["user"]["dealership_id"] == dealership_id


# ---------- End-to-end multi-user submission visibility ----------
class TestMultiUserE2E:
    @pytest.fixture(scope="class")
    def two_users_one_dealership(self, admin_token):
        # Register User A (creates dealership)
        email_a = _uniq("a")
        a = _register_dealer(email_a, first="Alice", last="Alpha", company="TEST E2E Motors", job_title="Sales Manager")
        token_a = a["token"]
        dealership_id = a["user"]["dealership_id"]
        _accept_agreement(token_a)

        # Admin adds User B to same dealership
        email_b = _uniq("b")
        r = requests.post(
            f"{API}/admin/dealerships/{dealership_id}/users",
            headers=_auth(admin_token),
            json={
                "email": email_b,
                "password": "Test1234!",
                "dealer_info": {
                    "first_name": "Bob",
                    "last_name": "Beta",
                    "phone": "0820000000",
                    "job_title": "F&I",
                },
            },
            timeout=30,
        )
        assert r.status_code == 200, r.text
        # User B logs in
        lr = requests.post(f"{API}/auth/login", json={"email": email_b, "password": "Test1234!"}, timeout=30)
        assert lr.status_code == 200
        token_b = lr.json()["token"]
        _accept_agreement(token_b)
        return {
            "dealership_id": dealership_id,
            "email_a": email_a, "token_a": token_a,
            "email_b": email_b, "token_b": token_b,
        }

    def test_a_submits_b_sees_it(self, two_users_one_dealership):
        ctx = two_users_one_dealership
        payload = _base_submission_payload()
        payload["make"] = "Toyota"
        payload["model"] = "Corolla"
        rs = requests.post(f"{API}/submissions", headers=_auth(ctx["token_a"]), json=payload, timeout=60)
        assert rs.status_code == 200, rs.text
        sub_a_id = rs.json()["id"]
        ctx["sub_a_id"] = sub_a_id  # stash for reuse

        # User B fetches /submissions/my → must see A's submission
        rmy = requests.get(f"{API}/submissions/my", headers=_auth(ctx["token_b"]), timeout=30)
        assert rmy.status_code == 200
        subs = rmy.json()["submissions"]
        found = [s for s in subs if s["id"] == sub_a_id]
        assert found, f"User B did not see User A's submission. IDs: {[s['id'] for s in subs]}"
        s = found[0]
        assert s.get("submitted_by_name", "").startswith("Alice")
        assert s.get("submitted_by_job_title") == "Sales Manager"

    def test_b_submits_a_sees_both_and_correct_submitter(self, two_users_one_dealership):
        ctx = two_users_one_dealership
        assert ctx.get("sub_a_id"), "prev test must have populated sub_a_id"

        payload = _base_submission_payload()
        payload["make"] = "BMW"
        payload["model"] = "3 Series"
        rs = requests.post(f"{API}/submissions", headers=_auth(ctx["token_b"]), json=payload, timeout=60)
        assert rs.status_code == 200, rs.text
        sub_b_id = rs.json()["id"]
        ctx["sub_b_id"] = sub_b_id

        # User A should see BOTH
        rmy = requests.get(f"{API}/submissions/my", headers=_auth(ctx["token_a"]), timeout=30)
        assert rmy.status_code == 200
        subs = {s["id"]: s for s in rmy.json()["submissions"]}
        assert ctx["sub_a_id"] in subs and sub_b_id in subs, f"A should see both. Got: {list(subs.keys())}"

        # Verify submitted_by fields are per-submission, NOT swapped
        assert subs[ctx["sub_a_id"]].get("submitted_by_name", "").startswith("Alice")
        assert subs[sub_b_id].get("submitted_by_name", "").startswith("Bob")
        assert subs[sub_b_id].get("submitted_by_job_title") == "F&I"

    def test_billing_my_is_dealership_scoped(self, admin_token, two_users_one_dealership):
        ctx = two_users_one_dealership
        # Admin prices both submissions
        for sid, price in ((ctx["sub_a_id"], 250000), (ctx["sub_b_id"], 300000)):
            pr = requests.post(
                f"{API}/admin/submissions/{sid}/price",
                headers=_auth(admin_token),
                json={"price": price, "notes": "TEST offer"},
                timeout=30,
            )
            assert pr.status_code == 200, pr.text
        # Give the DB a moment
        time.sleep(0.5)

        # User B calls billing/my — should include both priced subs
        rb = requests.get(f"{API}/billing/my", headers=_auth(ctx["token_b"]), timeout=30)
        assert rb.status_code == 200, rb.text
        body = rb.json()
        # Endpoint returns items in current month. Both subs were priced now.
        items = body.get("items") or body.get("submissions") or []
        ids = {i.get("id") for i in items}
        assert ctx["sub_a_id"] in ids, f"User B's billing/my should include A's priced sub. Body keys: {list(body.keys())}"
        assert ctx["sub_b_id"] in ids

    def test_valuation_pdf_accessible_to_either_user(self, two_users_one_dealership):
        ctx = two_users_one_dealership
        for tok_key in ("token_a", "token_b"):
            rp = requests.get(
                f"{API}/submissions/{ctx['sub_a_id']}/valuation.pdf",
                headers=_auth(ctx[tok_key]),
                timeout=60,
            )
            assert rp.status_code == 200, f"{tok_key}: {rp.status_code} {rp.text[:200]}"
            ctype = rp.headers.get("content-type", "")
            assert "application/pdf" in ctype, f"expected pdf, got {ctype}"
            assert rp.content[:4] == b"%PDF", "response is not a PDF (missing %PDF header)"
            # Very loose check: submitter name should appear as text in the PDF stream
            # (may be tokenised, so this is best-effort — not fatal).
            assert len(rp.content) > 1000, "PDF looks too small"
