"""Tests for the new stock_items architecture (Aug 2026 rework).

The stock silo is now a dedicated MongoDB collection (``stock_items``)
populated via ``POST /api/submissions/{sid}/transfer-to-stock`` and
reversible via ``POST /api/submissions/{sid}/untransfer-from-stock``.

Covers:
  * Auth 401 on every stock endpoint
  * POST transfer-to-stock: happy path + all failure modes
  * POST untransfer-from-stock: happy path + failures (not transferred, sold)
  * GET /api/stock: new response shape (no reference/purchase_price/front_photo)
  * PATCH /api/stock/{id}: multi-field partial update + validation
  * POST /api/stock/{id}/mark-sold: item disappears from list
  * GET /api/stock/export.csv: exact new column headers
"""

from __future__ import annotations

import os
import re
import uuid
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


# ==================== helpers ====================

def _login(email: str, password: str) -> str | None:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    if r.status_code != 200:
        return None
    j = r.json()
    return j.get("token") or j.get("access_token")


def _hdr(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


def _uniq(prefix: str = "STK-TEST") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:6].upper()}"


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
def priced_submission_id(admin_token: str) -> str:
    """Return a submission with priced_at set and NOT yet transferred."""
    r = requests.get(
        f"{BASE_URL}/api/admin/submissions?limit=500",
        headers=_hdr(admin_token),
        timeout=30,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    subs = body if isinstance(body, list) else body.get("items") or body.get("submissions") or []
    for s in subs:
        if s.get("priced_at") and not s.get("stock_item_id"):
            return s["id"]
    pytest.skip("no priced+un-transferred submission available in preview DB")


@pytest.fixture(scope="module")
def unpriced_submission_id(admin_token: str) -> str:
    """Return a submission WITHOUT priced_at (subject-to-view)."""
    r = requests.get(
        f"{BASE_URL}/api/admin/submissions?limit=500",
        headers=_hdr(admin_token),
        timeout=30,
    )
    assert r.status_code == 200
    body = r.json()
    subs = body if isinstance(body, list) else body.get("items") or body.get("submissions") or []
    for s in subs:
        if not s.get("priced_at") and not s.get("stock_item_id"):
            return s["id"]
    pytest.skip("no unpriced submission available")


# ==================== 1) Auth 401 ====================

class TestAuth401:
    """Every stock endpoint must reject unauthenticated calls."""

    def test_get_stock_401(self):
        r = requests.get(f"{BASE_URL}/api/stock", timeout=30)
        assert r.status_code in (401, 403), r.status_code

    def test_transfer_401(self):
        r = requests.post(
            f"{BASE_URL}/api/submissions/xxx/transfer-to-stock",
            json={"stock_number": "STK-TEST-NA", "target_sell_price_zar": 1},
            timeout=30,
        )
        assert r.status_code in (401, 403)

    def test_untransfer_401(self):
        r = requests.post(
            f"{BASE_URL}/api/submissions/xxx/untransfer-from-stock", timeout=30
        )
        assert r.status_code in (401, 403)

    def test_patch_stock_401(self):
        r = requests.patch(
            f"{BASE_URL}/api/stock/xxx",
            json={"target_sell_price_zar": 1},
            timeout=30,
        )
        assert r.status_code in (401, 403)

    def test_mark_sold_401(self):
        r = requests.post(
            f"{BASE_URL}/api/stock/xxx/mark-sold",
            json={"sale_price_zar": 1},
            timeout=30,
        )
        assert r.status_code in (401, 403)

    def test_export_csv_401(self):
        r = requests.get(f"{BASE_URL}/api/stock/export.csv", timeout=30)
        assert r.status_code in (401, 403)


# ==================== 2) Transfer to stock ====================

class TestTransferToStock:

    def test_transfer_success_admin(self, admin_token: str, priced_submission_id: str):
        sn = _uniq()
        r = requests.post(
            f"{BASE_URL}/api/submissions/{priced_submission_id}/transfer-to-stock",
            headers=_hdr(admin_token),
            json={"stock_number": sn, "target_sell_price_zar": 350000},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("id"), body
        assert body["stock_number"] == sn, body
        assert body["target_sell_price_zar"] == 350000, body
        # Persist stock_item_id for downstream tests
        pytest.stock_item_id = body["id"]
        pytest.stock_submission_id = priced_submission_id
        pytest.stock_number_used = sn

        # Verify via GET /api/stock
        gr = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(admin_token), timeout=30)
        assert gr.status_code == 200
        items = gr.json()["items"]
        match = next((it for it in items if it["id"] == body["id"]), None)
        assert match is not None, "new stock item missing from GET /api/stock"
        assert match["stock_number"] == sn
        assert match["submission_id"] == priced_submission_id
        assert "reference" not in match, "reference field should be removed"
        assert "purchase_price_zar" not in match, "purchase_price_zar removed"
        assert "front_photo" not in match, "front_photo removed"
        for k in (
            "id", "submission_id", "stock_number", "mm_code", "year", "make_name",
            "model_name", "derivative_name", "mileage", "vin", "colour",
            "condition_score", "my_offer_price_zar", "target_sell_price_zar",
            "purchased_at", "days_in_stock", "dealership_id",
        ):
            assert k in match, f"missing item key: {k}"

    def test_transfer_rejects_already_transferred(self, admin_token: str):
        sid = getattr(pytest, "stock_submission_id", None)
        if not sid:
            pytest.skip("preceding transfer test did not run")
        r = requests.post(
            f"{BASE_URL}/api/submissions/{sid}/transfer-to-stock",
            headers=_hdr(admin_token),
            json={"stock_number": _uniq(), "target_sell_price_zar": 111000},
            timeout=30,
        )
        assert r.status_code == 400, r.text
        assert "already" in r.text.lower()

    def test_transfer_rejects_duplicate_stock_number(
        self, admin_token: str, priced_submission_id: str
    ):
        """Duplicate stock_number within same dealership → 409."""
        # find a second priced sub in the SAME dealership as the first
        r = requests.get(
            f"{BASE_URL}/api/admin/submissions?limit=500",
            headers=_hdr(admin_token),
            timeout=30,
        )
        j = r.json()
        subs = j if isinstance(j, list) else (j.get("items") or j.get("submissions") or [])
        first = next((s for s in subs if s.get("id") == priced_submission_id), None)
        if not first:
            pytest.skip("could not resolve first submission for duplicate check")
        target_dship = first.get("dealership_id")
        candidate = next(
            (
                s for s in subs
                if s.get("priced_at")
                and not s.get("stock_item_id")
                and s.get("dealership_id") == target_dship
                and s.get("id") != priced_submission_id
            ),
            None,
        )
        if not candidate:
            pytest.skip("no second priced submission in same dealership")
        dup_sn = getattr(pytest, "stock_number_used", None)
        assert dup_sn, "prior test must set stock_number_used"
        rr = requests.post(
            f"{BASE_URL}/api/submissions/{candidate['id']}/transfer-to-stock",
            headers=_hdr(admin_token),
            json={"stock_number": dup_sn, "target_sell_price_zar": 100000},
            timeout=30,
        )
        assert rr.status_code == 409, rr.text

    def test_transfer_rejects_unpriced(self, admin_token: str, unpriced_submission_id: str):
        r = requests.post(
            f"{BASE_URL}/api/submissions/{unpriced_submission_id}/transfer-to-stock",
            headers=_hdr(admin_token),
            json={"stock_number": _uniq(), "target_sell_price_zar": 100000},
            timeout=30,
        )
        assert r.status_code == 400, r.text
        assert "subject" in r.text.lower() or "not been fully valued" in r.text.lower()

    def test_transfer_rejects_non_managerial(self, mini_token: str, admin_token: str):
        """minitest is not is_pricing_agent → 403."""
        # find any priced sub that is NOT already transferred and belongs to mini's dealership.
        # If none, use ANY priced sub — the 403 branch fires before the "not your dealership" branch
        # because is_pricing_agent check is first.
        r = requests.get(
            f"{BASE_URL}/api/admin/submissions?limit=500",
            headers=_hdr(admin_token),
            timeout=30,
        )
        j = r.json()
        subs = j if isinstance(j, list) else (j.get("items") or j.get("submissions") or [])
        sub = next((s for s in subs if s.get("priced_at") and not s.get("stock_item_id")), None)
        if not sub:
            pytest.skip("no priced+un-transferred sub for 403 test")
        rr = requests.post(
            f"{BASE_URL}/api/submissions/{sub['id']}/transfer-to-stock",
            headers=_hdr(mini_token),
            json={"stock_number": _uniq(), "target_sell_price_zar": 100000},
            timeout=30,
        )
        assert rr.status_code == 403, rr.text


# ==================== 3) PATCH /api/stock/{id} ====================

class TestPatchStock:

    def test_patch_target_price_only(self, admin_token: str):
        sid = getattr(pytest, "stock_item_id", None)
        if not sid:
            pytest.skip("no stock item from transfer test")
        r = requests.patch(
            f"{BASE_URL}/api/stock/{sid}",
            headers=_hdr(admin_token),
            json={"target_sell_price_zar": 375500},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json().get("target_sell_price_zar") == 375500

    def test_patch_multi_field(self, admin_token: str):
        sid = getattr(pytest, "stock_item_id", None)
        if not sid:
            pytest.skip("no stock item")
        r = requests.patch(
            f"{BASE_URL}/api/stock/{sid}",
            headers=_hdr(admin_token),
            json={"mileage": 55555, "colour": "Alpine White", "condition_score": 7.2},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("mileage") == 55555, body
        assert body.get("colour") == "Alpine White", body
        assert body.get("condition_score") == 7.2, body

    def test_patch_duplicate_stock_number_409(self, admin_token: str, priced_submission_id: str):
        """Insert a second stock item then try to rename ours to its number."""
        # find a second priced sub in same dealership
        r = requests.get(
            f"{BASE_URL}/api/admin/submissions?limit=500",
            headers=_hdr(admin_token),
            timeout=30,
        )
        j = r.json()
        subs = j if isinstance(j, list) else (j.get("items") or j.get("submissions") or [])
        our_sub = next((s for s in subs if s.get("id") == priced_submission_id), None)
        if not our_sub:
            pytest.skip("cannot resolve source sub")
        second = next(
            (
                s for s in subs
                if s.get("priced_at") and not s.get("stock_item_id")
                and s.get("dealership_id") == our_sub.get("dealership_id")
                and s.get("id") != priced_submission_id
            ),
            None,
        )
        if not second:
            pytest.skip("no second sub in same dealership for dup PATCH test")
        second_sn = _uniq("STK-TEST-DUP")
        tr = requests.post(
            f"{BASE_URL}/api/submissions/{second['id']}/transfer-to-stock",
            headers=_hdr(admin_token),
            json={"stock_number": second_sn, "target_sell_price_zar": 100000},
            timeout=30,
        )
        assert tr.status_code == 200, tr.text
        pytest.second_stock_id = tr.json()["id"]

        # Now try to rename our first item to second_sn → 409
        sid = getattr(pytest, "stock_item_id", None)
        rr = requests.patch(
            f"{BASE_URL}/api/stock/{sid}",
            headers=_hdr(admin_token),
            json={"stock_number": second_sn},
            timeout=30,
        )
        assert rr.status_code == 409, rr.text

    def test_patch_blank_stock_number_400(self, admin_token: str):
        sid = getattr(pytest, "stock_item_id", None)
        if not sid:
            pytest.skip("no stock item")
        r = requests.patch(
            f"{BASE_URL}/api/stock/{sid}",
            headers=_hdr(admin_token),
            json={"stock_number": "   "},
            timeout=30,
        )
        assert r.status_code == 400, r.text

    def test_patch_non_managerial_403(self, mini_token: str):
        sid = getattr(pytest, "stock_item_id", None)
        if not sid:
            pytest.skip("no stock item")
        r = requests.patch(
            f"{BASE_URL}/api/stock/{sid}",
            headers=_hdr(mini_token),
            json={"target_sell_price_zar": 999},
            timeout=30,
        )
        assert r.status_code == 403, r.text


# ==================== 4) GET /api/stock shape ====================

class TestListShape:

    def test_admin_list_shape(self, admin_token: str):
        r = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(admin_token), timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "summary" in data and "items" in data
        for k in ("total_units", "total_capital_zar", "avg_age_days", "over_60_days", "buckets"):
            assert k in data["summary"], f"missing summary key {k}"
        # no legacy fields anywhere
        for it in data["items"]:
            assert "reference" not in it
            assert "purchase_price_zar" not in it
            assert "front_photo" not in it


# ==================== 5) Untransfer ====================

class TestUntransfer:

    def test_untransfer_not_transferred_400(self, admin_token: str, unpriced_submission_id: str):
        r = requests.post(
            f"{BASE_URL}/api/submissions/{unpriced_submission_id}/untransfer-from-stock",
            headers=_hdr(admin_token),
            timeout=30,
        )
        assert r.status_code == 400, r.text

    def test_untransfer_success(self, admin_token: str):
        """Reverse the second (STK-TEST-DUP) transfer created earlier."""
        sid_stock = getattr(pytest, "second_stock_id", None)
        if not sid_stock:
            pytest.skip("no second stock item to untransfer")
        # Look up submission id for it via GET stock
        gr = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(admin_token), timeout=30)
        item = next((it for it in gr.json()["items"] if it["id"] == sid_stock), None)
        assert item is not None
        sub_id = item["submission_id"]
        r = requests.post(
            f"{BASE_URL}/api/submissions/{sub_id}/untransfer-from-stock",
            headers=_hdr(admin_token),
            timeout=30,
        )
        assert r.status_code == 200, r.text
        # Verify disappearance
        gr2 = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(admin_token), timeout=30)
        assert not any(it["id"] == sid_stock for it in gr2.json()["items"])
        pytest.second_stock_id = None


# ==================== 6) Mark sold ====================

class TestMarkSold:

    def test_mark_sold_success_and_disappears(self, admin_token: str):
        sid = getattr(pytest, "stock_item_id", None)
        if not sid:
            pytest.skip("no stock item")
        r = requests.post(
            f"{BASE_URL}/api/stock/{sid}/mark-sold",
            headers=_hdr(admin_token),
            json={
                "sale_price_zar": 400000,
                "recon_cost_zar": 8000,
                "buyer_name": "TEST Buyer",
                "buyer_notes": "TEST sale",
                "sold_at": "2026-08-12",
            },
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("sold") is True
        assert body.get("sale_price_zar") == 400000
        # Item must disappear from list
        gr = requests.get(f"{BASE_URL}/api/stock", headers=_hdr(admin_token), timeout=30)
        assert not any(it["id"] == sid for it in gr.json()["items"])

    def test_patch_sold_item_400(self, admin_token: str):
        sid = getattr(pytest, "stock_item_id", None)
        if not sid:
            pytest.skip("no stock item")
        r = requests.patch(
            f"{BASE_URL}/api/stock/{sid}",
            headers=_hdr(admin_token),
            json={"target_sell_price_zar": 1},
            timeout=30,
        )
        assert r.status_code == 400, r.text

    def test_untransfer_sold_400(self, admin_token: str):
        sub_id = getattr(pytest, "stock_submission_id", None)
        if not sub_id:
            pytest.skip("no submission id")
        r = requests.post(
            f"{BASE_URL}/api/submissions/{sub_id}/untransfer-from-stock",
            headers=_hdr(admin_token),
            timeout=30,
        )
        assert r.status_code == 400, r.text
        assert "sold" in r.text.lower()


# ==================== 7) CSV export ====================

class TestCsvExport:

    EXPECTED_DEALER_HEADER = (
        "Stock #,Reference (Submission),Year,Make,Model,Derivative,"
        "M&M Code,VIN,Mileage,Colour,Condition Score,"
        "My Offer (ZAR),Target Sell (ZAR),Transferred At,Days in Stock"
    )

    def test_admin_csv_headers_exact(self, admin_token: str):
        r = requests.get(
            f"{BASE_URL}/api/stock/export.csv",
            headers=_hdr(admin_token),
            timeout=30,
        )
        assert r.status_code == 200
        assert "text/csv" in r.headers.get("content-type", "")
        assert re.search(r'filename="stock-\d{8}\.csv"', r.headers.get("content-disposition", ""))
        header = r.text.splitlines()[0]
        # admin gets the exact dealer header + ",Dealership"
        assert header == self.EXPECTED_DEALER_HEADER + ",Dealership", (
            f"admin CSV header mismatch:\n  got: {header!r}\n  exp: {self.EXPECTED_DEALER_HEADER + ',Dealership'!r}"
        )

    def test_dealer_csv_headers_exact(self, mini_token: str):
        r = requests.get(
            f"{BASE_URL}/api/stock/export.csv",
            headers=_hdr(mini_token),
            timeout=30,
        )
        assert r.status_code == 200
        header = r.text.splitlines()[0]
        assert header == self.EXPECTED_DEALER_HEADER, (
            f"dealer CSV header mismatch:\n  got: {header!r}\n  exp: {self.EXPECTED_DEALER_HEADER!r}"
        )


# ==================== 8) Removed endpoint ====================

class TestRemovedTargetPriceEndpoint:

    def test_old_target_price_endpoint_gone(self, admin_token: str):
        """PATCH /api/stock/{id}/target-price should no longer exist —
        the generic PATCH /api/stock/{id} replaces it."""
        r = requests.patch(
            f"{BASE_URL}/api/stock/anything/target-price",
            headers=_hdr(admin_token),
            json={"target_sell_price_zar": 1},
            timeout=30,
        )
        # 404 (route removed) or 405 (method not allowed) are both acceptable.
        # NOT 200, NOT 400 (would suggest the route still exists).
        assert r.status_code in (404, 405), r.text
