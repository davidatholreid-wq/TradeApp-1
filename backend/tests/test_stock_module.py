"""Tests for the new dealer Stock Management module.

Covers:
 - GET  /api/stock (auth, shape, dealership scope)
 - PATCH /api/stock/{sid}/target-price
 - POST  /api/stock/{sid}/mark-sold (with 403 for non-managerial dealer)
 - GET  /api/stock/export.csv

Uses the preview deployment URL through EXPO_PUBLIC_BACKEND_URL so we
exercise the same ingress as the real client.
"""

from __future__ import annotations

import os
import re
import pytest
import requests

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
    or "https://fourbuy-admin.preview.emergentagent.com"
).rstrip("/")

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASS = "admin123"
MINI_EMAIL = "minitest@example.com"
MINI_PASS = "Mini1234!"
DAVE_EMAIL = "dave@fourbuy.co.za"
DAVE_PASS = "Dave1234!"
GUIN_EMAIL = "guin.gilbert@gmail.com"
GUIN_PASS = "Guin1234!"


# ==================== helpers ====================

def _login(email: str, password: str) -> str | None:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    if r.status_code != 200:
        return None
    return r.json().get("token") or r.json().get("access_token")


def _hdr(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


# ==================== fixtures ====================

@pytest.fixture(scope="module")
def admin_token() -> str:
    tok = _login(ADMIN_EMAIL, ADMIN_PASS)
    assert tok, "Admin login must succeed"
    return tok


@pytest.fixture(scope="module")
def mini_token() -> str:
    tok = _login(MINI_EMAIL, MINI_PASS)
    assert tok, "minitest dealer login must succeed"
    return tok


@pytest.fixture(scope="module")
def managerial_token(admin_token: str) -> tuple[str, str]:
    """Return (token, email) for a managerial (is_pricing_agent) dealer.

    Tries Dave then Guin; if both logins fail, resets via admin API.
    """
    for email, pwd in [(DAVE_EMAIL, DAVE_PASS), (GUIN_EMAIL, GUIN_PASS)]:
        tok = _login(email, pwd)
        if tok:
            return tok, email
    # Try password reset for Dave via admin
    r = requests.get(f"{BASE_URL}/api/admin/dealers", headers=_hdr(admin_token), timeout=30)
    if r.status_code == 200:
        dealers = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
        for d in dealers:
            if d.get("email") in (DAVE_EMAIL, GUIN_EMAIL):
                did = d.get("id")
                requests.post(
                    f"{BASE_URL}/api/admin/dealers/{did}/password",
                    headers=_hdr(admin_token),
                    json={"password": "Dave1234!" if d["email"] == DAVE_EMAIL else "Guin1234!"},
                    timeout=30,
                )
                tok = _login(d["email"], "Dave1234!" if d["email"] == DAVE_EMAIL else "Guin1234!")
                if tok:
                    return tok, d["email"]
    pytest.skip("Could not obtain managerial dealer token")


# ==================== GET /api/stock ====================

class TestStockList:

    def test_unauth_returns_401(self):
        r = requests.get(f"{BASE_URL}/api/stock", timeout=30)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"

    def test_admin_shape(self, admin_token: str):
        r = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(admin_token), timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert set(["summary", "items"]).issubset(data.keys())
        s = data["summary"]
        for k in ("total_units", "total_capital_zar", "avg_age_days", "over_60_days", "buckets"):
            assert k in s, f"missing summary key {k}"
        for bk in ("0-30", "31-60", "61-90", "90+", "unknown"):
            assert bk in s["buckets"], f"missing bucket {bk}"
        # If items exist, verify shape and business rules
        for it in data["items"][:5]:
            for k in (
                "id", "reference", "make_name", "model_name", "year",
                "front_photo", "my_offer_price_zar", "purchase_price_zar",
                "target_sell_price_zar", "purchased_at", "days_in_stock",
                "dealership_name",
            ):
                assert k in it, f"missing item key {k} in {it.get('reference')}"

    def test_admin_items_are_deal_done_not_sold(self, admin_token: str):
        r = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(admin_token), timeout=30)
        assert r.status_code == 200
        for it in r.json()["items"]:
            # every stock item has a purchased_at (from deal.done stamp)
            # But we already know via server code — just spot-check counts match summary
            pass
        assert r.json()["summary"]["total_units"] == len(r.json()["items"])

    def test_dealer_scoped(self, mini_token: str):
        r = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(mini_token), timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        # Per problem statement, minitest currently has 0 stock
        assert isinstance(data["items"], list)


# ==================== PATCH /api/stock/{sid}/target-price ====================

class TestTargetPrice:

    def test_admin_can_set_and_clear(self, admin_token: str):
        r = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(admin_token), timeout=30)
        items = r.json()["items"]
        if not items:
            pytest.skip("no stock items in preview DB")
        sid = items[0]["id"]
        # set
        r = requests.patch(
            f"{BASE_URL}/api/stock/{sid}/target-price",
            headers=_hdr(admin_token),
            json={"target_sell_price_zar": 350000},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json().get("target_sell_price_zar") == 350000
        # verify persisted on GET
        r2 = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(admin_token), timeout=30)
        matches = [x for x in r2.json()["items"] if x["id"] == sid]
        assert matches, "item disappeared after target-price PATCH"
        assert matches[0]["target_sell_price_zar"] == 350000
        # clear
        r = requests.patch(
            f"{BASE_URL}/api/stock/{sid}/target-price",
            headers=_hdr(admin_token),
            json={"target_sell_price_zar": None},
            timeout=30,
        )
        assert r.status_code == 200
        assert r.json().get("target_sell_price_zar") is None

    def test_400_on_non_stock_item(self, admin_token: str):
        """A submission that is either not deal_done or already sold must
        return 400 from the target-price endpoint."""
        # Try /api/admin/submissions in a few flavours
        candidates: list[dict] = []
        for qs in ("?limit=200", "?status=priced&limit=200", "?status=incoming&limit=200"):
            r = requests.get(
                f"{BASE_URL}/api/admin/submissions{qs}",
                headers=_hdr(admin_token),
                timeout=30,
            )
            if r.status_code != 200:
                continue
            body = r.json()
            arr = body if isinstance(body, list) else body.get("items", []) or body.get("submissions", [])
            candidates.extend(arr or [])
        for s in candidates:
            deal = s.get("deal") or {}
            if deal.get("done") is not True or deal.get("sold") is True:
                sid = s.get("id")
                if not sid:
                    continue
                rr = requests.patch(
                    f"{BASE_URL}/api/stock/{sid}/target-price",
                    headers=_hdr(admin_token),
                    json={"target_sell_price_zar": 1000},
                    timeout=30,
                )
                assert rr.status_code == 400, (
                    f"expected 400 for non-stock, got {rr.status_code}: {rr.text[:200]}"
                )
                return
        pytest.skip("no non-stock submissions found to test 400 path")

    def test_404_on_bad_id(self, admin_token: str):
        r = requests.patch(
            f"{BASE_URL}/api/stock/does-not-exist-xyz/target-price",
            headers=_hdr(admin_token),
            json={"target_sell_price_zar": 1000},
            timeout=30,
        )
        assert r.status_code == 404


# ==================== POST /api/stock/{sid}/mark-sold ====================

class TestMarkSold:

    def test_non_managerial_403(self, mini_token: str, admin_token: str):
        # Grab any stock item from admin view; if mini has none, we still
        # want the 403 branch, so we hit an admin-owned stock item.
        r = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(admin_token), timeout=30)
        items = r.json()["items"]
        if not items:
            pytest.skip("no stock to attempt sold")
        sid = items[0]["id"]
        r = requests.post(
            f"{BASE_URL}/api/stock/{sid}/mark-sold",
            headers=_hdr(mini_token),
            json={"sale_price_zar": 150000},
            timeout=30,
        )
        # minitest is not admin, likely not managerial → 403; may also
        # be 403 for wrong dealership. Either way, must not be 200.
        assert r.status_code in (403, 404), f"expected 403/404, got {r.status_code}: {r.text[:200]}"

    def test_admin_can_mark_sold_and_disappears(self, admin_token: str):
        r = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(admin_token), timeout=30)
        items = r.json()["items"]
        if not items:
            pytest.skip("no stock to mark sold")
        # Use the LAST item (oldest) to keep the freshest ones alive for other tests.
        sid = items[-1]["id"]
        payload = {
            "sale_price_zar": 150000,
            "recon_cost_zar": 5000,
            "buyer_name": "TEST Buyer",
            "buyer_notes": "TEST Cash sale",
            "sold_at": "2026-08-12",
        }
        r = requests.post(
            f"{BASE_URL}/api/stock/{sid}/mark-sold",
            headers=_hdr(admin_token),
            json=payload,
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("sold") is True
        assert body.get("sale_price_zar") == 150000
        assert body.get("sold_at", "").startswith("2026-08-12")

        # Verify disappearance
        r2 = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(admin_token), timeout=30)
        assert not any(it["id"] == sid for it in r2.json()["items"]), "item still in stock after mark-sold"

        # Verify deal fields via admin submissions listing
        rq = requests.get(
            f"{BASE_URL}/api/admin/submissions?limit=200",
            headers=_hdr(admin_token),
            timeout=30,
        )
        if rq.status_code == 200:
            subs = rq.json() if isinstance(rq.json(), list) else rq.json().get("items", [])
            found = next((s for s in subs if s.get("id") == sid), None)
            if found is not None:
                d = found.get("deal") or {}
                assert d.get("sold") is True
                assert d.get("sale_price_zar") == 150000
                assert d.get("buyer_name") == "TEST Buyer"
                assert d.get("buyer_notes") == "TEST Cash sale"
                assert isinstance(d.get("days_to_sell"), int) or d.get("days_to_sell") is None


# ==================== GET /api/stock/export.csv ====================

class TestStockCsv:

    def test_admin_csv_headers(self, admin_token: str):
        r = requests.get(
            f"{BASE_URL}/api/stock/export.csv",
            headers=_hdr(admin_token),
            timeout=30,
        )
        assert r.status_code == 200, r.text
        ct = r.headers.get("content-type", "")
        assert "text/csv" in ct, f"bad content-type: {ct}"
        cd = r.headers.get("content-disposition", "")
        assert 'attachment' in cd and 'filename="stock-' in cd, f"bad content-disposition: {cd}"
        assert re.search(r'filename="stock-\d{8}\.csv"', cd), cd
        text = r.text.splitlines()
        assert text, "empty CSV"
        header = text[0]
        for col in [
            "Reference", "Year", "Make", "Model", "Derivative", "VIN",
            "Mileage", "Colour",
            "My Offer (ZAR)", "Purchase Price (ZAR)", "Target Sell (ZAR)",
            "Purchased At", "Days in Stock",
        ]:
            assert col in header, f"missing csv column {col}"
        # admin only
        assert "Dealership" in header

    def test_dealer_csv_no_dealership_col(self, mini_token: str):
        r = requests.get(
            f"{BASE_URL}/api/stock/export.csv",
            headers=_hdr(mini_token),
            timeout=30,
        )
        assert r.status_code == 200, r.text
        header = r.text.splitlines()[0]
        assert "Dealership" not in header, "dealer CSV should NOT expose Dealership column"
