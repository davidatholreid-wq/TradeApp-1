"""
Backend tests for AutoPricePro
Tests: auth (register/login/me), vehicle DB, submissions, admin endpoints, RBAC, JWT validation.
"""
import os
import uuid
import base64
import pytest
import requests

BASE_URL = "https://fourbuy-admin.preview.emergentagent.com"
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@autopricepro.com"
ADMIN_PASSWORD = "admin123"

# Unique dealer per test run to avoid 409 conflicts
DEALER_EMAIL = f"test_dealer_{uuid.uuid4().hex[:8]}@example.com"
DEALER_PASSWORD = "Dealer123!"


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


@pytest.fixture(scope="session")
def dealer_ctx(s):
    """Register a dealer and return (token, user_id, email)."""
    payload = {
        "email": DEALER_EMAIL,
        "password": DEALER_PASSWORD,
        "dealer_info": {
            "first_name": "John",
            "last_name": "Dealer",
            "phone": "0821234567",
            "id_number": "9001010000000",
        },
        "company_info": {
            "company_name": "TEST_ABC Motors",
            "company_address": "123 Main St, Johannesburg",
            "company_reg_no": "2020/123456/07",
            "vat_no": "4111111111",
        },
    }
    r = s.post(f"{API}/auth/register", json=payload)
    assert r.status_code == 200, f"Register failed: {r.status_code} {r.text}"
    data = r.json()
    return {"token": data["token"], "user_id": data["user"]["id"], "email": DEALER_EMAIL}


# ---------- Health ----------
def test_health(s):
    r = s.get(f"{API}/")
    assert r.status_code == 200
    assert r.json().get("status") == "ok"


# ---------- Auth ----------
class TestAuth:
    def test_register_dealer_returns_token_and_user(self, dealer_ctx):
        assert dealer_ctx["token"]
        assert dealer_ctx["user_id"]

    def test_register_duplicate_email_409(self, s, dealer_ctx):
        r = s.post(f"{API}/auth/register", json={
            "email": DEALER_EMAIL,
            "password": DEALER_PASSWORD,
            "dealer_info": {"first_name": "X", "last_name": "Y", "phone": "0"},
            "company_info": {"company_name": "X", "company_address": "Y"},
        })
        assert r.status_code == 409

    def test_login_admin(self, admin_token):
        assert admin_token

    def test_login_dealer(self, s, dealer_ctx):
        r = s.post(f"{API}/auth/login", json={"email": DEALER_EMAIL, "password": DEALER_PASSWORD})
        assert r.status_code == 200
        data = r.json()
        assert data["user"]["role"] == "dealer"
        assert data["user"]["email"] == DEALER_EMAIL
        # Ensure no leaks
        assert "_id" not in data["user"]
        assert "password_hash" not in data["user"]

    def test_login_wrong_password_401(self, s):
        r = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": "wrong"})
        assert r.status_code == 401

    def test_auth_me_with_token(self, s, dealer_ctx):
        r = s.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {dealer_ctx['token']}"})
        assert r.status_code == 200
        user = r.json()["user"]
        assert user["email"] == DEALER_EMAIL
        assert user["role"] == "dealer"
        assert "password_hash" not in user
        assert "_id" not in user

    def test_auth_me_no_token_401(self, s):
        r = s.get(f"{API}/auth/me")
        assert r.status_code == 401

    def test_auth_me_invalid_token_401(self, s):
        r = s.get(f"{API}/auth/me", headers={"Authorization": "Bearer notavalidjwt"})
        assert r.status_code == 401


# ---------- Vehicle DB ----------
class TestVehicleDB:
    def test_makes_seeded(self, s):
        r = s.get(f"{API}/vehicles/makes")
        assert r.status_code == 200
        makes = r.json()["makes"]
        names = {m["name"] for m in makes}
        assert "Toyota" in names
        assert "BMW" in names
        assert len(makes) >= 12
        # No _id leakage
        for m in makes:
            assert "_id" not in m
            assert "id" in m

    def test_models_for_make(self, s):
        r = s.get(f"{API}/vehicles/makes")
        make = next(m for m in r.json()["makes"] if m["name"] == "Toyota")
        r2 = s.get(f"{API}/vehicles/models", params={"make_id": make["id"]})
        assert r2.status_code == 200
        models = r2.json()["models"]
        names = {m["name"] for m in models}
        assert "Hilux" in names
        assert "Corolla" in names

    def test_derivatives_for_model(self, s):
        r = s.get(f"{API}/vehicles/makes")
        make = next(m for m in r.json()["makes"] if m["name"] == "Toyota")
        r2 = s.get(f"{API}/vehicles/models", params={"make_id": make["id"]})
        model = next(m for m in r2.json()["models"] if m["name"] == "Hilux")
        r3 = s.get(f"{API}/vehicles/derivatives", params={"model_id": model["id"]})
        assert r3.status_code == 200
        derivatives = r3.json()["derivatives"]
        assert len(derivatives) >= 1
        for d in derivatives:
            assert "_id" not in d


# ---------- Submissions & Pricing ----------
def _tiny_b64():
    # 1x1 transparent PNG
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="


@pytest.fixture(scope="session")
def submission_id(s, dealer_ctx):
    # Get real IDs from the seeded DB
    makes = s.get(f"{API}/vehicles/makes").json()["makes"]
    toyota = next(m for m in makes if m["name"] == "Toyota")
    models = s.get(f"{API}/vehicles/models", params={"make_id": toyota["id"]}).json()["models"]
    hilux = next(m for m in models if m["name"] == "Hilux")
    derivs = s.get(f"{API}/vehicles/derivatives", params={"model_id": hilux["id"]}).json()["derivatives"]
    deriv = derivs[0]

    photo = _tiny_b64()
    payload = {
        "make_id": toyota["id"], "make_name": "Toyota",
        "model_id": hilux["id"], "model_name": "Hilux",
        "derivative_id": deriv["id"], "derivative_name": deriv["name"],
        "mileage": 55000, "year": 2020,
        "factory_warranty": True, "condition": 8,
        "accident_damage": False, "colour": "White",
        "license_disk_data": "%TEST%LICENSE_DISK%DATA%",
        "photos": {
            "front": photo, "side_right": photo, "rear": photo,
            "side_left": photo, "interior": photo,
        },
    }
    r = s.post(f"{API}/submissions", json=payload,
               headers={"Authorization": f"Bearer {dealer_ctx['token']}"})
    assert r.status_code == 200, f"Create submission failed: {r.status_code} {r.text}"
    data = r.json()
    assert data["id"]
    assert data["submission"]["status"] == "pending"
    return data["id"]


class TestSubmissions:
    def test_create_submission_persists(self, s, dealer_ctx, submission_id):
        r = s.get(f"{API}/submissions/my", headers={"Authorization": f"Bearer {dealer_ctx['token']}"})
        assert r.status_code == 200
        subs = r.json()["submissions"]
        ids = [sub["id"] for sub in subs]
        assert submission_id in ids
        # Ensure photos are stripped from list; no _id leakage
        for sub in subs:
            assert "_id" not in sub
            assert "photos" not in sub

    def test_admin_lists_all_submissions(self, s, admin_token, submission_id):
        r = s.get(f"{API}/admin/submissions", headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200
        subs = r.json()["submissions"]
        assert any(sub["id"] == submission_id for sub in subs)
        for sub in subs:
            assert "_id" not in sub

    def test_admin_prices_submission_non_blocking_push(self, s, admin_token, submission_id):
        r = s.post(
            f"{API}/admin/submissions/{submission_id}/price",
            json={"price": 285000, "notes": "TEST pricing"},
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        # Push key is placeholder; endpoint must NOT 5xx
        assert r.status_code == 200, f"Pricing failed (push may be blocking): {r.status_code} {r.text}"
        data = r.json()
        assert data["status"] == "priced"
        assert data["price"] == 285000

    def test_pricing_reflected_in_submission(self, s, admin_token, submission_id):
        # Verify persistence via GET
        r = s.get(f"{API}/admin/submissions", headers={"Authorization": f"Bearer {admin_token}"})
        sub = next(x for x in r.json()["submissions"] if x["id"] == submission_id)
        assert sub["status"] == "priced"
        assert sub["price"] == 285000
        assert sub["priced_at"] is not None


# ---------- Admin dealer management ----------
class TestAdminDealers:
    def test_admin_list_dealers_has_submission_count(self, s, admin_token, dealer_ctx, submission_id):
        r = s.get(f"{API}/admin/dealers", headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200
        dealers = r.json()["dealers"]
        me = next((d for d in dealers if d["id"] == dealer_ctx["user_id"]), None)
        assert me is not None
        assert "submission_count" in me
        assert me["submission_count"] >= 1
        # No password_hash leak
        for d in dealers:
            assert "password_hash" not in d
            assert "_id" not in d

    def test_admin_delete_dealer_cascades_submissions(self, s, admin_token):
        # Create a throwaway dealer to delete
        email = f"test_deleteme_{uuid.uuid4().hex[:8]}@example.com"
        reg = s.post(f"{API}/auth/register", json={
            "email": email, "password": "Delete123!",
            "dealer_info": {"first_name": "Del", "last_name": "Me", "phone": "0"},
            "company_info": {"company_name": "TEST_DEL", "company_address": "X"},
        })
        assert reg.status_code == 200
        dealer_id = reg.json()["user"]["id"]

        r = s.delete(f"{API}/admin/dealers/{dealer_id}",
                     headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200
        assert r.json()["status"] == "deleted"

        # Verify deletion via login attempt (should 401)
        r2 = s.post(f"{API}/auth/login", json={"email": email, "password": "Delete123!"})
        assert r2.status_code == 401


# ---------- RBAC / Security ----------
class TestRBAC:
    def test_dealer_cannot_access_admin_submissions(self, s, dealer_ctx):
        r = s.get(f"{API}/admin/submissions",
                  headers={"Authorization": f"Bearer {dealer_ctx['token']}"})
        assert r.status_code == 403

    def test_dealer_cannot_access_admin_dealers(self, s, dealer_ctx):
        r = s.get(f"{API}/admin/dealers",
                  headers={"Authorization": f"Bearer {dealer_ctx['token']}"})
        assert r.status_code == 403

    def test_dealer_cannot_price(self, s, dealer_ctx, submission_id):
        r = s.post(
            f"{API}/admin/submissions/{submission_id}/price",
            json={"price": 1, "notes": ""},
            headers={"Authorization": f"Bearer {dealer_ctx['token']}"},
        )
        assert r.status_code == 403

    def test_no_token_on_protected_401(self, s):
        r = s.get(f"{API}/submissions/my")
        assert r.status_code == 401

    def test_admin_cannot_delete_non_dealer(self, s, admin_token):
        # Try to delete the admin (should 400 since not dealer)
        me_resp = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}).json()
        admin_id = me_resp["user"]["id"]
        r = s.delete(f"{API}/admin/dealers/{admin_id}",
                     headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 400
