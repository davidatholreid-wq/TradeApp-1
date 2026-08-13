"""Backend tests for the Outvin multi-make Factory Options integration.

Covers:
  - order outvin_spec on VW FB-000155 (already ordered during dev; verified in DB).
  - order outvin_spec on BMW FB-000116 (coexists with existing bimmer_spec).
  - order outvin_spec on Mercedes FB-000156 (coexists with existing mb_spec).
  - non-supported make (Chery FB-000128) is rejected with 400.
  - duplicate order returns 409.
  - Quota remaining is logged in backend.err.log.

Outvin quota is LIMITED (~14 credits at test start). We reuse cached data
where possible and only burn 2 credits (BMW + Merc).
"""

import os
import re
import subprocess
import time
from pathlib import Path

import pytest
import requests

BASE = os.environ["EXPO_BACKEND_URL"].rstrip("/") if os.environ.get("EXPO_BACKEND_URL") else "https://fourbuy-admin.preview.emergentagent.com"
ADMIN = ("admin@fourbuy.co.za", "admin123")
DEALER = ("dave@fourbuy.co.za", "Dave1234!")

VW_REF, VW_ID, VW_VIN = "FB-000155", "a18787ac-b4ea-41f6-ae03-90bc41322559", "WVGZZZ5NZJW402485"
BMW_REF, BMW_ID, BMW_VIN = "FB-000116", "2d25bdf7-378c-4bdf-9c96-fa3fa89541be", "WBA42DT0909N56153"
MB_REF, MB_ID, MB_VIN = "FB-000156", "38b860ee-fb00-4784-a7a0-987031de2325", "W1K2060872R185836"
CHERY_ID = "e8e52bfb-8b04-48bd-b198-171d135439c9"  # FB-000128 Chery (non-supported)


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE}/api/auth/login",
                      json={"email": ADMIN[0], "password": ADMIN[1]}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def dealer_token():
    r = requests.post(f"{BASE}/api/auth/login",
                      json={"email": DEALER[0], "password": DEALER[1]}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def hdr(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def dhdr(dealer_token):
    return {"Authorization": f"Bearer {dealer_token}", "Content-Type": "application/json"}


def _get_sub(sub_id, hdr):
    r = requests.get(f"{BASE}/api/submissions/{sub_id}", headers=hdr, timeout=20)
    assert r.status_code == 200, r.text
    body = r.json()
    # GET wraps in {"submission": {...}}
    if isinstance(body, dict) and "submission" in body and isinstance(body["submission"], dict):
        return body["submission"]
    return body


def _post_order(sub_id, rtype, hdr):
    return requests.post(
        f"{BASE}/api/submissions/{sub_id}/reports",
        headers=hdr,
        json={"type": rtype, "accepted_charge": True},
        timeout=90,
    )


# ---------------------------------------------------------------------------
# 1. VW FB-000155 — already ordered; verify persisted state
# ---------------------------------------------------------------------------

def test_vw_outvin_spec_persisted(hdr):
    sub = _get_sub(VW_ID, hdr)
    os_ = sub.get("outvin_spec") or {}
    assert os_.get("status") == "ok", f"outvin_spec not persisted: {os_}"
    assert os_.get("make") == "Volkswagen"
    assert "Tiguan" in (os_.get("model") or ""), os_.get("model")
    assert (os_.get("options_total") or 0) > 100, os_.get("options_total")
    assert os_.get("options_with_desc") == os_.get("options_total"), "100% named options expected"
    assert os_.get("production_date") == "2018-03-05"
    assert (os_.get("vin") or "").upper() == VW_VIN


def test_vw_report_order_row(hdr):
    r = requests.get(f"{BASE}/api/submissions/{VW_ID}/reports", headers=hdr, timeout=15)
    assert r.status_code == 200, r.text
    orders = r.json()
    if isinstance(orders, dict):
        orders = orders.get("reports") or orders.get("items") or orders.get("orders") or []
    outvin_rows = [o for o in orders if o.get("type") == "outvin_spec"]
    assert outvin_rows, "no outvin_spec report_order row for VW"
    row = outvin_rows[0]
    assert row.get("cost_zar") == 20 or row.get("cost_zar") == 20.0
    assert (row.get("status") or "").lower() == "delivered"


# ---------------------------------------------------------------------------
# 2. BMW FB-000116 — new order (burns 1 credit); coexists with bimmer_spec
# ---------------------------------------------------------------------------

def test_bmw_order_outvin_spec_and_coexist(hdr, dhdr):
    sub = _get_sub(BMW_ID, hdr)
    if not sub.get("outvin_spec"):
        r = _post_order(BMW_ID, "outvin_spec", dhdr)
        assert r.status_code in (200, 201), f"outvin_spec order failed: {r.status_code} {r.text}"
    sub = _get_sub(BMW_ID, hdr)
    os_ = sub.get("outvin_spec") or {}
    assert os_.get("status") == "ok"
    assert os_.get("make") == "BMW"
    # Model must be human-readable — NOT "G30 JC52" style Bimmervin code
    assert "X4" in (os_.get("model") or ""), f"model={os_.get('model')!r}"
    # Series / generation / engine / power sanity
    assert os_.get("series")
    assert (os_.get("generation") or "").upper().startswith("G02") or "G02" in (os_.get("generation") or "").upper()
    assert (os_.get("engine_code") or "").upper().startswith("B58"), os_.get("engine_code")
    assert os_.get("power_kw") == 285, os_.get("power_kw")
    # Coexists with bimmer_spec
    assert sub.get("bimmer_spec"), "bimmer_spec must still be present on BMW submission"


# ---------------------------------------------------------------------------
# 3. Mercedes FB-000156 — new order (burns 1 credit); coexists with mb_spec
# ---------------------------------------------------------------------------

def test_mb_order_outvin_spec_and_coexist(hdr, dhdr):
    sub = _get_sub(MB_ID, hdr)
    if not sub.get("outvin_spec"):
        r = _post_order(MB_ID, "outvin_spec", dhdr)
        assert r.status_code in (200, 201), f"outvin_spec order failed: {r.status_code} {r.text}"
    sub = _get_sub(MB_ID, hdr)
    os_ = sub.get("outvin_spec") or {}
    assert os_.get("status") == "ok"
    assert os_.get("make") == "Mercedes-Benz"
    assert "C 43" in (os_.get("model") or "") or "Mercedes-AMG C 43" in (os_.get("model") or ""), os_.get("model")
    # 100 % named options claim from the PR description
    total = os_.get("options_total") or 0
    named = os_.get("options_with_desc") or 0
    assert total > 0
    assert named == total, f"expected 100% named options, got {named}/{total}"
    # Coexists with mb_spec
    assert sub.get("mb_spec"), "mb_spec must still be present on Mercedes submission"


# ---------------------------------------------------------------------------
# 4. Non-supported make (Chery) — must be blocked with 400
# ---------------------------------------------------------------------------

def test_non_supported_make_blocked(dhdr):
    r = _post_order(CHERY_ID, "outvin_spec", dhdr)
    assert r.status_code == 400, f"expected 400 for non-supported make, got {r.status_code}: {r.text}"


# ---------------------------------------------------------------------------
# 5. Duplicate order returns 409
# ---------------------------------------------------------------------------

def test_duplicate_order_conflict(dhdr):
    # VW already has outvin_spec ordered
    r = _post_order(VW_ID, "outvin_spec", dhdr)
    assert r.status_code == 409, f"expected 409 on duplicate, got {r.status_code}: {r.text}"


# ---------------------------------------------------------------------------
# 6. Quota logging present in backend.err.log
# ---------------------------------------------------------------------------

def test_quota_logging():
    logs = Path("/var/log/supervisor")
    if not logs.exists():
        pytest.skip("no supervisor log dir")
    text = ""
    for f in list(logs.glob("backend.err.log*")) + list(logs.glob("backend.out.log*")):
        try:
            text += f.read_text(errors="ignore")[-200_000:]
        except Exception:
            continue
    # Look for the informative log line the client emits
    m = re.search(r"outvin: decoded VIN=\S+ make=\S+.*options=\d+/\d+ \((-?\d+) requests remaining\)", text)
    assert m, "no 'outvin: decoded ...' quota log line found in backend logs"
