"""Phase 3 — Self-service DELETE /api/auth/me + regressions.

Covers:
  1. Wrong password -> 401 (Password does not match)
  2. Admin cannot self-delete -> 403
  3. Regression: PATCH /api/auth/me still 403; GET /api/auth/me still 200
  4. Single-user dealership last-user guard -> 409
  5. Two-user dealership -> first delete succeeds; second (now last) -> 409
  6. After deletion: login rejected as 401 "Invalid email or password"
     (no tombstone leak); old bearer token rejected as 401 "Account has been deleted"
"""
from __future__ import annotations

import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"

SA_ID_A = "9202204720083"
SA_ID_B = "8501015009086"


def _login(email: str, password: str) -> requests.Response:
    return requests.post(f"{BASE_URL}/api/auth/login",
                         json={"email": email, "password": password}, timeout=30)


def _admin_headers() -> dict:
    r = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return {"Authorization": f"Bearer {r.json()['token']}", "Content-Type": "application/json"}


def _create_dealership(admin_h: dict, name: str) -> str:
    r = requests.post(f"{BASE_URL}/api/admin/dealerships",
                      headers=admin_h,
                      json={"name": name, "address": "1 Test St, JHB", "active": True},
                      timeout=30)
    assert r.status_code == 200, f"create dealership: {r.status_code} {r.text}"
    return r.json()["dealership"]["id"]


def _invite_user(admin_h: dict, dealership_id: str, email: str, password: str, sa_id: str = SA_ID_A) -> str:
    payload = {
        "email": email,
        "password": password,
        "dealer_info": {"first_name": "TEST", "last_name": "User", "phone": "0821111111"},
        "sa_id_number": sa_id,
        "active": True,
    }
    r = requests.post(f"{BASE_URL}/api/admin/dealerships/{dealership_id}/users",
                      headers=admin_h, json=payload, timeout=30)
    assert r.status_code == 200, f"invite user: {r.status_code} {r.text}"
    return r.json()["user"]["id"]


# ---------------------------------------------------------------------------
class TestAdminSelfDeleteBlocked:
    """Admins must not be able to self-delete via /api/auth/me."""

    def test_admin_cannot_self_delete(self):
        h = _admin_headers()
        r = requests.delete(f"{BASE_URL}/api/auth/me",
                            headers=h,
                            json={"password": ADMIN_PASSWORD}, timeout=30)
        assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text}"
        assert "admin" in (r.json().get("detail") or "").lower()


# ---------------------------------------------------------------------------
class TestSelfProfileRegressions:
    """PATCH /api/auth/me stays disabled; GET /api/auth/me still returns profile."""

    def test_patch_me_still_403(self):
        h = _admin_headers()
        r = requests.patch(f"{BASE_URL}/api/auth/me",
                           headers=h, json={"first_name": "X"}, timeout=30)
        assert r.status_code == 403

    def test_get_me_still_200_for_non_deleted(self):
        h = _admin_headers()
        r = requests.get(f"{BASE_URL}/api/auth/me", headers=h, timeout=30)
        assert r.status_code == 200
        body = r.json()
        assert body.get("user", {}).get("email") == ADMIN_EMAIL


# ---------------------------------------------------------------------------
class TestWrongPassword:
    def test_wrong_password_returns_401(self):
        admin_h = _admin_headers()
        d_id = _create_dealership(admin_h, f"TEST_del_wrongpw_{uuid.uuid4().hex[:6]}")
        email = f"test_wrongpw_{uuid.uuid4().hex[:6]}@test.co.za"
        _invite_user(admin_h, d_id, email, "GoodPass1!", SA_ID_A)
        # add a second user so the last-user guard doesn't kick in first
        email2 = f"test_wrongpw2_{uuid.uuid4().hex[:6]}@test.co.za"
        _invite_user(admin_h, d_id, email2, "GoodPass1!", SA_ID_B)

        tok = _login(email, "GoodPass1!").json()["token"]
        h = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
        r = requests.delete(f"{BASE_URL}/api/auth/me",
                            headers=h, json={"password": "WRONG"}, timeout=30)
        assert r.status_code == 401, f"expected 401, got {r.status_code} {r.text}"
        assert "password" in (r.json().get("detail") or "").lower()


# ---------------------------------------------------------------------------
class TestLastUserGuard:
    def test_solo_user_blocked_with_409(self):
        admin_h = _admin_headers()
        d_id = _create_dealership(admin_h, f"TEST_solo_{uuid.uuid4().hex[:6]}")
        email = f"solo_{uuid.uuid4().hex[:6]}@test.co.za"
        _invite_user(admin_h, d_id, email, "SoloPass1!", SA_ID_A)

        tok = _login(email, "SoloPass1!").json()["token"]
        h = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
        r = requests.delete(f"{BASE_URL}/api/auth/me",
                            headers=h, json={"password": "SoloPass1!"}, timeout=30)
        assert r.status_code == 409, f"expected 409, got {r.status_code} {r.text}"
        detail = (r.json().get("detail") or "").lower()
        assert "last remaining" in detail or "contact fourbuy" in detail


# ---------------------------------------------------------------------------
class TestTwoUserSequentialDelete:
    def test_first_deletes_then_second_blocked(self):
        admin_h = _admin_headers()
        d_id = _create_dealership(admin_h, f"TEST_pair_{uuid.uuid4().hex[:6]}")
        email_a = f"pair_a_{uuid.uuid4().hex[:6]}@test.co.za"
        email_b = f"pair_b_{uuid.uuid4().hex[:6]}@test.co.za"
        _invite_user(admin_h, d_id, email_a, "PairA1!", SA_ID_A)
        _invite_user(admin_h, d_id, email_b, "PairB1!", SA_ID_B)

        # A deletes successfully
        tok_a = _login(email_a, "PairA1!").json()["token"]
        h_a = {"Authorization": f"Bearer {tok_a}", "Content-Type": "application/json"}
        r_a = requests.delete(f"{BASE_URL}/api/auth/me",
                              headers=h_a, json={"password": "PairA1!", "reason": "TEST"}, timeout=30)
        assert r_a.status_code == 200, f"first delete: {r_a.status_code} {r_a.text}"
        body_a = r_a.json()
        assert body_a.get("deleted") is True
        assert "purge_after" in body_a

        # After A deleted -> A's login now 401 (Invalid email or password — no tombstone leak)
        rl = _login(email_a, "PairA1!")
        assert rl.status_code == 401
        assert "invalid email or password" in (rl.json().get("detail") or "").lower()

        # A's old bearer token -> 401 "Account has been deleted"
        r_me = requests.get(f"{BASE_URL}/api/auth/me", headers=h_a, timeout=30)
        assert r_me.status_code == 401, f"old token should 401, got {r_me.status_code}"
        assert "account has been deleted" in (r_me.json().get("detail") or "").lower()

        # B tries to delete → last remaining → 409
        tok_b = _login(email_b, "PairB1!").json()["token"]
        h_b = {"Authorization": f"Bearer {tok_b}", "Content-Type": "application/json"}
        r_b = requests.delete(f"{BASE_URL}/api/auth/me",
                              headers=h_b, json={"password": "PairB1!"}, timeout=30)
        assert r_b.status_code == 409, f"second delete should 409, got {r_b.status_code} {r_b.text}"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
