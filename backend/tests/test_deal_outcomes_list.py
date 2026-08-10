"""
Tests for the /api/stats/deal-outcomes/list endpoint.

Covers:
  * Dealer scoped call (dave@fourbuy.co.za)
  * Admin scoped call (admin@fourbuy.co.za)
  * Response schema (period_days, counts, percentages, pending, deal_done, no_deal)
  * Percentage math (sum to 100 when at least one answered, 0/0 when none)
"""

import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")


def _login(session, email, password):
    r = session.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text}"
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, f"no token in login response: {r.json()}"
    session.headers.update({"Authorization": f"Bearer {tok}"})
    return r.json()


@pytest.fixture(scope="module")
def dealer_session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    _login(s, "dave@fourbuy.co.za", "Dave1234!")
    return s


@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    _login(s, "admin@fourbuy.co.za", "admin123")
    return s


class TestDealOutcomesListSchema:
    """Response schema validation for /api/stats/deal-outcomes/list."""

    def _assert_schema(self, body):
        assert isinstance(body, dict)
        assert body.get("period_days") == 90, f"expected period_days=90, got {body.get('period_days')}"
        for k in ("counts", "percentages", "pending", "deal_done", "no_deal"):
            assert k in body, f"missing key: {k}"
        for k in ("pending", "deal_done", "no_deal"):
            assert k in body["counts"]
            assert isinstance(body["counts"][k], int)
        for k in ("deal_done", "no_deal"):
            assert k in body["percentages"]
            assert isinstance(body["percentages"][k], (int, float))
        for k in ("pending", "deal_done", "no_deal"):
            assert isinstance(body[k], list), f"{k} should be list"

    def test_dealer_call(self, dealer_session):
        r = dealer_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        assert r.status_code == 200, r.text
        self._assert_schema(r.json())

    def test_admin_call(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        assert r.status_code == 200, r.text
        self._assert_schema(r.json())

    def test_percent_math(self, dealer_session):
        r = dealer_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        body = r.json()
        c = body["counts"]
        p = body["percentages"]
        answered = c["deal_done"] + c["no_deal"]
        if answered == 0:
            assert p["deal_done"] == 0 and p["no_deal"] == 0
        else:
            # allow tiny rounding drift (rounded to 1 decimal each side).
            total = p["deal_done"] + p["no_deal"]
            assert 99.0 <= total <= 101.0, f"expected ~100, got {total}"

    def test_counts_match_list_lengths(self, dealer_session):
        r = dealer_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        body = r.json()
        assert body["counts"]["pending"] == len(body["pending"])
        assert body["counts"]["deal_done"] == len(body["deal_done"])
        assert body["counts"]["no_deal"] == len(body["no_deal"])

    def test_row_shape(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        body = r.json()
        # If any list has rows, check shape.
        for bucket in ("pending", "deal_done", "no_deal"):
            for row in body[bucket][:1]:
                assert "id" in row
                assert "_id" not in row, "mongodb _id must not leak"

    def test_admin_totals_ge_dealer(self, admin_session, dealer_session):
        """Admin roll-up should be >= any single dealership's counts."""
        a = admin_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30).json()
        d = dealer_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30).json()
        for k in ("pending", "deal_done", "no_deal"):
            assert a["counts"][k] >= d["counts"][k], f"admin {k}({a['counts'][k]}) < dealer {k}({d['counts'][k]})"


class TestDealOutcomesListAuth:
    def test_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"
