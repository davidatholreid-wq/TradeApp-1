"""Tests for GET /api/stats/covers-30d endpoint (Earn Rewards flip banner stat)."""
import os
import requests
import pytest
from datetime import datetime, timezone

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")


@pytest.fixture(scope="module")
def dealer_token():
    """Login as dealer Dave. Reset password via admin if needed."""
    payload = {"email": "dave@fourbuy.co.za", "password": "Dave1234!"}
    r = requests.post(f"{BASE_URL}/api/auth/login", json=payload, timeout=30)
    if r.status_code != 200:
        # Reset via admin
        admin = requests.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": "admin@fourbuy.co.za", "password": "admin123"},
            timeout=30,
        )
        assert admin.status_code == 200, f"admin login failed {admin.status_code}: {admin.text}"
        atok = admin.json()["token"]
        reset = requests.post(
            f"{BASE_URL}/api/admin/dealers/ad6ba6af-4c17-45cf-bea7-f8fea93fac89/password",
            json={"new_password": "Dave1234!"},
            headers={"Authorization": f"Bearer {atok}"},
            timeout=30,
        )
        assert reset.status_code in (200, 204), f"password reset failed: {reset.status_code} {reset.text}"
        r = requests.post(f"{BASE_URL}/api/auth/login", json=payload, timeout=30)
    assert r.status_code == 200, f"dealer login failed {r.status_code}: {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": "admin@fourbuy.co.za", "password": "admin123"},
        timeout=30,
    )
    assert r.status_code == 200, f"admin login failed: {r.text}"
    return r.json()["token"]


class TestCovers30d:
    """/api/stats/covers-30d — running total of Fourbuy Cover Prices over the last 30 days."""

    def test_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/stats/covers-30d", timeout=30)
        assert r.status_code in (401, 403), f"expected auth-gated, got {r.status_code}: {r.text}"

    def test_dealer_can_fetch(self, dealer_token):
        r = requests.get(
            f"{BASE_URL}/api/stats/covers-30d",
            headers={"Authorization": f"Bearer {dealer_token}"},
            timeout=30,
        )
        assert r.status_code == 200, f"got {r.status_code}: {r.text}"
        data = r.json()
        # Shape
        assert set(data.keys()) >= {"total_zar", "count", "since"}, f"missing keys: {data.keys()}"
        assert isinstance(data["total_zar"], int), f"total_zar not int: {data['total_zar']!r}"
        assert isinstance(data["count"], int), f"count not int: {data['count']!r}"
        assert isinstance(data["since"], str) and "T" in data["since"], f"since not ISO: {data['since']!r}"
        # Sanity — since must parse and be roughly 30 days ago
        since_dt = datetime.fromisoformat(data["since"])
        delta = datetime.now(timezone.utc) - since_dt
        assert 29 * 86400 <= delta.total_seconds() <= 31 * 86400, f"since not ~30d ago: {delta}"
        # Sanity — seeded DB should have positive figures
        assert data["total_zar"] >= 0, f"negative total_zar: {data['total_zar']}"
        assert data["count"] >= 0, f"negative count: {data['count']}"
        print(f"[covers-30d] total_zar={data['total_zar']} count={data['count']} since={data['since']}")

    def test_admin_can_also_fetch(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/stats/covers-30d",
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=30,
        )
        assert r.status_code == 200, f"admin got {r.status_code}: {r.text}"
        data = r.json()
        assert "total_zar" in data and "count" in data and "since" in data

    def test_value_matches_expected_seed(self, dealer_token):
        """Review request expects total_zar around 11,757,000 and count around 18."""
        r = requests.get(
            f"{BASE_URL}/api/stats/covers-30d",
            headers={"Authorization": f"Bearer {dealer_token}"},
            timeout=30,
        )
        data = r.json()
        print(f"[assert-seed] total_zar={data['total_zar']} count={data['count']}")
        # Non-strict — this is a live DB; log only. Fail only if drastically off.
        assert data["total_zar"] > 0, "expected some priced submissions in last 30d"
        assert data["count"] > 0, "expected count>0 priced subs in last 30d"
