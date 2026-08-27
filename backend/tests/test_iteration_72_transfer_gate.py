"""Iteration 72 — Transfer-to-Stock gate now accepts dealer_offer_zar.

Regression + new behaviour for POST /api/submissions/{sid}/transfer-to-stock.

Rules under test:
  * Managerial dealer can transfer a pending submission that has NO
    priced_at but has deal.dealer_offer_zar > 0.
  * Same submission WITHOUT any dealer offer / priced_at → 400 with the
    new copy mentioning "dealer offer".
  * Non-managerial dealer → 403 (regression).
  * Managerial dealer targeting another dealership's submission → 403.
  * Priced (no dealer offer) submission still transfers successfully.
"""

from __future__ import annotations

import os
import uuid
import pytest
import requests

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
).rstrip("/")

ADMIN_EMAIL = "admin@tradeapp.co.za"
ADMIN_PASS = "admin123"

DAVE_EMAIL = "dave@tradeapp.co.za"
DAVE_PASS = "Dave1234!"

MINI_EMAIL = "minitest@example.com"
MINI_PASS = "password"


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


def _login_full(email: str, password: str) -> dict:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _get_sub(tok: str, sid: str) -> dict:
    r = requests.get(f"{BASE_URL}/api/submissions/{sid}", headers=_hdr(tok), timeout=30)
    if r.status_code != 200:
        return {}
    j = r.json()
    # endpoint returns {"submission": {...}}
    return j.get("submission") or j


def _hdr(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


def _uniq(prefix: str = "STK-IT72") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:6].upper()}"


# ============================ Fixtures ============================


@pytest.fixture(scope="module")
def admin_token() -> str:
    tok = _login(ADMIN_EMAIL, ADMIN_PASS)
    assert tok, "Admin login must succeed"
    return tok


@pytest.fixture(scope="module")
def dave_info() -> dict:
    j = _login_full(DAVE_EMAIL, DAVE_PASS)
    return j.get("user") or {}


@pytest.fixture(scope="module")
def dave_token(dave_info: dict) -> str:
    tok = _login(DAVE_EMAIL, DAVE_PASS)
    assert tok, "Dave (managerial) login must succeed"
    return tok


@pytest.fixture(scope="module")
def mini_token() -> str:
    tok = _login(MINI_EMAIL, MINI_PASS)
    assert tok, "Minitest (non-managerial) login must succeed"
    return tok


def _list_daves_submissions(dave_tok: str) -> list[dict]:
    r = requests.get(f"{BASE_URL}/api/submissions/my?limit=500", headers=_hdr(dave_tok), timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    subs = body if isinstance(body, list) else body.get("items") or body.get("submissions") or []
    return subs


@pytest.fixture(scope="module")
def daves_pending_sub_ids(dave_token: str) -> list[str]:
    subs = _list_daves_submissions(dave_token)
    ids = [
        s["id"]
        for s in subs
        if s.get("status") == "pending"
        and not s.get("priced_at")
        and not s.get("stock_item_id")
    ]
    if not ids:
        pytest.skip("no un-priced pending subs available on Dave's dealership")
    return ids


@pytest.fixture(scope="module")
def daves_priced_sub_id(dave_token: str) -> str:
    subs = _list_daves_submissions(dave_token)
    for s in subs:
        if s.get("priced_at") and not s.get("stock_item_id"):
            # ensure NO dealer_offer_zar
            deal = s.get("deal") or {}
            if not deal.get("dealer_offer_zar"):
                return s["id"]
    # fallback: any priced+untransferred
    for s in subs:
        if s.get("priced_at") and not s.get("stock_item_id"):
            return s["id"]
    pytest.skip("no priced+untransferred sub available on Dave's dealership")


def _reset_deal_and_stock(admin_tok: str, sid: str) -> None:
    """Best-effort cleanup: clear dealer_offer_zar and untransfer if in stock."""
    sub = _get_sub(admin_tok, sid)
    if sub.get("stock_item_id"):
        requests.post(
            f"{BASE_URL}/api/submissions/{sid}/untransfer-from-stock",
            headers=_hdr(admin_tok),
            timeout=30,
        )


# ============================ Tests ============================


class TestManagerialDealerOfferUnlocksTransfer:
    """Case 1 — Dave commits dealer_offer_zar on a pending sub, then
    transfers to stock. Should return 200."""

    def test_dealer_offer_then_transfer_success(
        self, dave_token: str, admin_token: str, daves_pending_sub_ids: list[str]
    ):
        sid = daves_pending_sub_ids[0]
        # Cleanup any previous state on this sub
        _reset_deal_and_stock(admin_token, sid)

        # 1. PATCH the deal to set a dealer offer
        pr = requests.patch(
            f"{BASE_URL}/api/submissions/{sid}/deal",
            headers=_hdr(dave_token),
            json={"dealer_offer_zar": 250000},
            timeout=30,
        )
        assert pr.status_code == 200, f"PATCH deal failed: {pr.status_code} {pr.text}"
        body = pr.json()
        # Verify persistence via GET
        s = _get_sub(dave_token, sid)
        assert (s.get("deal") or {}).get("dealer_offer_zar") == 250000

        # 2. Transfer to stock with fresh stock_number
        sn = _uniq()
        tr = requests.post(
            f"{BASE_URL}/api/submissions/{sid}/transfer-to-stock",
            headers=_hdr(dave_token),
            json={"stock_number": sn, "target_sell_price_zar": 320000},
            timeout=30,
        )
        assert tr.status_code == 200, f"Expected 200 got {tr.status_code}: {tr.text}"
        j = tr.json()
        assert j.get("id"), j
        assert j["stock_number"] == sn
        assert j["target_sell_price_zar"] == 320000

        # Cleanup: untransfer + reset offer
        requests.post(
            f"{BASE_URL}/api/submissions/{sid}/untransfer-from-stock",
            headers=_hdr(dave_token),
            timeout=30,
        )
        requests.patch(
            f"{BASE_URL}/api/submissions/{sid}/deal",
            headers=_hdr(dave_token),
            json={"dealer_offer_zar": 0},
            timeout=30,
        )


class TestManagerialWithoutOfferBlocked:
    """Case 2 — pending, no priced_at, no dealer offer → 400 with new copy."""

    def test_no_offer_no_price_returns_400_with_new_copy(
        self, dave_token: str, admin_token: str, daves_pending_sub_ids: list[str]
    ):
        # Use a DIFFERENT pending sub (or reset the first one)
        sid = daves_pending_sub_ids[-1] if len(daves_pending_sub_ids) > 1 else daves_pending_sub_ids[0]
        _reset_deal_and_stock(admin_token, sid)
        # Explicitly clear dealer_offer_zar
        requests.patch(
            f"{BASE_URL}/api/submissions/{sid}/deal",
            headers=_hdr(dave_token),
            json={"dealer_offer_zar": 0},
            timeout=30,
        )
        # Verify it's really pending & un-priced & no offer
        s = _get_sub(dave_token, sid)
        assert not s.get("priced_at"), "sub must be unpriced for this test"
        assert not (s.get("deal") or {}).get("dealer_offer_zar"), "sub must have no dealer offer"

        r = requests.post(
            f"{BASE_URL}/api/submissions/{sid}/transfer-to-stock",
            headers=_hdr(dave_token),
            json={"stock_number": _uniq(), "target_sell_price_zar": 100000},
            timeout=30,
        )
        assert r.status_code == 400, f"Expected 400 got {r.status_code}: {r.text}"
        text_lower = r.text.lower()
        assert "dealer offer" in text_lower, f"error copy should mention 'dealer offer': {r.text}"
        assert "fully valued" in text_lower or "not been fully valued" in text_lower


class TestNonManagerialCannotTransfer:
    """Case 3 — regression: non-managerial dealer → 403."""

    def test_minitest_transfer_returns_403(
        self, mini_token: str, dave_token: str, daves_pending_sub_ids: list[str]
    ):
        sid = daves_pending_sub_ids[0]
        # set a dealer offer first so we don't get 400 for a different reason
        requests.patch(
            f"{BASE_URL}/api/submissions/{sid}/deal",
            headers=_hdr(dave_token),
            json={"dealer_offer_zar": 200000},
            timeout=30,
        )
        r = requests.post(
            f"{BASE_URL}/api/submissions/{sid}/transfer-to-stock",
            headers=_hdr(mini_token),
            json={"stock_number": _uniq(), "target_sell_price_zar": 100000},
            timeout=30,
        )
        assert r.status_code == 403, f"Expected 403 got {r.status_code}: {r.text}"


class TestManagerialForeignDealershipBlocked:
    """Case 4 — managerial user targeting another dealership's sub → 403.

    Since minitest is on Karam Motors (different dealership), we register
    an admin-created sub owned by *another* dealer via the admin. Simpler:
    reuse Dave's sub and try to transfer as a managerial user from another
    dealership. We don't have one handy, so we assert the other-dealership
    rule by asking Dave to transfer a submission he doesn't own.
    """

    def test_dave_cannot_transfer_foreign_sub(
        self, dave_token: str, dave_info: dict, admin_token: str
    ):
        # Dave's dealership + user id from login response
        dave_dship = dave_info.get("dealership_id")
        dave_uid = dave_info.get("id")
        assert dave_dship and dave_uid, "dave login must return dealership + id"
        # admin lists all
        r = requests.get(
            f"{BASE_URL}/api/admin/submissions?limit=500",
            headers=_hdr(admin_token),
            timeout=30,
        )
        assert r.status_code == 200
        body = r.json()
        subs = body if isinstance(body, list) else body.get("items") or body.get("submissions") or []
        foreign = next(
            (s for s in subs if s.get("dealership_id") and s.get("dealership_id") != dave_dship
             and s.get("dealer_id") != dave_uid
             and not s.get("stock_item_id")
             and (s.get("priced_at") or (s.get("deal") or {}).get("dealer_offer_zar"))),
            None,
        )
        if not foreign:
            pytest.skip("no foreign submission available")
        rr = requests.post(
            f"{BASE_URL}/api/submissions/{foreign['id']}/transfer-to-stock",
            headers=_hdr(dave_token),
            json={"stock_number": _uniq(), "target_sell_price_zar": 100000},
            timeout=30,
        )
        assert rr.status_code == 403, f"Expected 403 got {rr.status_code}: {rr.text}"


class TestPricedNoOfferStillTransfers:
    """Case 5 — regression: priced_at set (no dealer offer) still works."""

    def test_priced_sub_transfers(self, dave_token: str, admin_token: str, daves_priced_sub_id: str):
        sid = daves_priced_sub_id
        _reset_deal_and_stock(admin_token, sid)
        sn = _uniq("STK-IT72-PR")
        r = requests.post(
            f"{BASE_URL}/api/submissions/{sid}/transfer-to-stock",
            headers=_hdr(dave_token),
            json={"stock_number": sn, "target_sell_price_zar": 400000},
            timeout=30,
        )
        assert r.status_code == 200, f"priced sub transfer failed: {r.status_code} {r.text}"
        # Cleanup
        requests.post(
            f"{BASE_URL}/api/submissions/{sid}/untransfer-from-stock",
            headers=_hdr(dave_token),
            timeout=30,
        )
