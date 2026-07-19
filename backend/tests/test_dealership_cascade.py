"""Tests for the new dealership-group toggle + cascade behaviour.

Covers:
- PATCH /api/admin/dealerships/{id} with {active: false} cascades to all
  non-archived users; {active: true} re-enables them.
- Suspended user cannot log in (403).
- GET /api/admin/dealers now includes a `dealership` field per dealer.
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get(
    "EXPO_PUBLIC_BACKEND_URL",
    "https://fourbuy-admin.preview.emergentagent.com",
).rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"


def _uniq(prefix: str) -> str:
    return f"test_{prefix}_{uuid.uuid4().hex[:8]}@example.com"


def _auth(t: str) -> dict:
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _register_dealer(email: str, first="Alice", last="Cascade", company="TEST Cascade Motors") -> dict:
    payload = {
        "email": email,
        "password": "Test1234!",
        "dealer_info": {"first_name": first, "last_name": last, "phone": "0821234567"},
        "company_info": {"company_name": company, "company_address": "1 Test St"},
    }
    r = requests.post(f"{API}/auth/register", json=payload, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


class TestDealershipCascade:
    @pytest.fixture(scope="class")
    def two_user_dealership(self, admin_token):
        # User A creates dealership
        email_a = _uniq("cas_a")
        a = _register_dealer(email_a, first="Alice", last="Cascade", company="TEST Cascade Motors")
        dship = a["user"]["dealership_id"]

        # Admin adds User B
        email_b = _uniq("cas_b")
        r = requests.post(
            f"{API}/admin/dealerships/{dship}/users",
            headers=_auth(admin_token),
            json={
                "email": email_b,
                "password": "Test1234!",
                "dealer_info": {"first_name": "Bob", "last_name": "Cascade", "phone": "0820000000"},
            },
            timeout=30,
        )
        assert r.status_code == 200, r.text
        return {"dship": dship, "email_a": email_a, "email_b": email_b}

    def test_patch_dealership_active_false_cascades_to_users(self, admin_token, two_user_dealership):
        ctx = two_user_dealership
        # Disable the dealership
        r = requests.patch(
            f"{API}/admin/dealerships/{ctx['dship']}",
            headers=_auth(admin_token),
            json={"active": False},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["dealership"]["active"] is False

        # Verify BOTH users are now active=false via GET /api/admin/dealers
        gd = requests.get(f"{API}/admin/dealers", headers=_auth(admin_token), timeout=30)
        assert gd.status_code == 200
        dealers = gd.json()["dealers"]
        my_users = [d for d in dealers if d["email"] in (ctx["email_a"], ctx["email_b"])]
        assert len(my_users) == 2, f"expected 2, got {len(my_users)}"
        for u in my_users:
            assert u.get("active") is False, f"{u['email']} not deactivated: {u.get('active')}"
            # Response should include dealership field
            assert isinstance(u.get("dealership"), dict), f"missing dealership on {u['email']}"
            assert u["dealership"]["id"] == ctx["dship"]
            assert u["dealership"]["active"] is False
            assert "name" in u["dealership"]

    def test_suspended_users_cannot_login(self, two_user_dealership):
        ctx = two_user_dealership
        for email in (ctx["email_a"], ctx["email_b"]):
            r = requests.post(
                f"{API}/auth/login",
                json={"email": email, "password": "Test1234!"},
                timeout=30,
            )
            assert r.status_code == 403, f"expected 403 for suspended {email}, got {r.status_code}: {r.text[:200]}"

    def test_patch_dealership_active_true_reenables_users(self, admin_token, two_user_dealership):
        ctx = two_user_dealership
        r = requests.patch(
            f"{API}/admin/dealerships/{ctx['dship']}",
            headers=_auth(admin_token),
            json={"active": True},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["dealership"]["active"] is True

        # Both users active=true again
        gd = requests.get(f"{API}/admin/dealers", headers=_auth(admin_token), timeout=30)
        assert gd.status_code == 200
        dealers = gd.json()["dealers"]
        my_users = [d for d in dealers if d["email"] in (ctx["email_a"], ctx["email_b"])]
        assert len(my_users) == 2
        for u in my_users:
            assert u.get("active") is True, f"{u['email']} still suspended"
            assert u["dealership"]["active"] is True

        # Users can now log in again
        for email in (ctx["email_a"], ctx["email_b"]):
            lr = requests.post(f"{API}/auth/login", json={"email": email, "password": "Test1234!"}, timeout=30)
            assert lr.status_code == 200, f"login should succeed for {email}: {lr.status_code} {lr.text[:200]}"

    def test_cascade_does_not_touch_archived_users(self, admin_token):
        """Register a dealership with 2 users, archive one, then disable the
        dealership. The archived user should be untouched (archived_at
        remains, and toggling shouldn't 'un-archive' them)."""
        email_a = _uniq("arc_a")
        a = _register_dealer(email_a, first="Anna", last="Arc", company="TEST Arc Motors")
        dship = a["user"]["dealership_id"]
        user_a_id = a["user"]["id"]

        email_b = _uniq("arc_b")
        r = requests.post(
            f"{API}/admin/dealerships/{dship}/users",
            headers=_auth(admin_token),
            json={
                "email": email_b,
                "password": "Test1234!",
                "dealer_info": {"first_name": "Bran", "last_name": "Arc", "phone": "0820000000"},
            },
            timeout=30,
        )
        assert r.status_code == 200
        # Archive user A
        ar = requests.post(
            f"{API}/admin/dealers/{user_a_id}/archive",
            headers=_auth(admin_token),
            timeout=30,
        )
        assert ar.status_code == 200, ar.text

        # Disable dealership
        pr = requests.patch(
            f"{API}/admin/dealerships/{dship}",
            headers=_auth(admin_token),
            json={"active": False},
            timeout=30,
        )
        assert pr.status_code == 200

        # Re-fetch: user_b should be inactive; user_a should still be archived
        # (not visible in default list).
        gd = requests.get(f"{API}/admin/dealers?include_archived=true", headers=_auth(admin_token), timeout=30)
        assert gd.status_code == 200
        dealers = gd.json()["dealers"]
        b_row = next((d for d in dealers if d["email"] == email_b), None)
        a_row = next((d for d in dealers if d["email"] == email_a), None)
        assert b_row is not None and a_row is not None
        assert b_row["active"] is False, "user B should have cascaded to inactive"
        assert a_row.get("archived_at"), "user A should still be archived"

    def test_admin_dealers_response_includes_dealership_field(self, admin_token):
        r = requests.get(f"{API}/admin/dealers", headers=_auth(admin_token), timeout=30)
        assert r.status_code == 200
        dealers = r.json()["dealers"]
        assert isinstance(dealers, list) and dealers, "expected at least one dealer"
        # Find any dealer with a dealership_id
        with_ds = [d for d in dealers if d.get("dealership_id")]
        assert with_ds, "expected at least one dealer with dealership_id"
        for d in with_ds[:5]:
            ds = d.get("dealership")
            assert isinstance(ds, dict), f"dealership missing on {d['email']}"
            assert "id" in ds and "name" in ds and "active" in ds
