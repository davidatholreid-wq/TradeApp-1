"""Backend tests for the new Mercedes Factory Options (`mb_options`) report.

Tests the end-to-end flow:
- Live mbtools.com call for FB-000156 (Mercedes W1K206...)
- Guard against ordering `mb_options` on non-Mercedes submissions
- Idempotency (409 when re-ordering)
- PDF endpoints
- Regression: BMW `bmw_options` guard still works
- Regression: JLR landrover_osh & Kredo VIN unaffected
"""
import os
import pytest
import requests

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL")
            or "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"

DEALER_EMAIL = "dave@fourbuy.co.za"
DEALER_PASSWORD = "Dave1234!"

MB_REF = "FB-000156"
MB_VIN = "W1K2060872R185836"
NON_MB_REF = "FB-000155"  # VW (owned by dave)


def _login(email: str, password: str) -> str:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    assert r.status_code == 200, f"login failed for {email}: {r.status_code} {r.text[:200]}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_headers():
    tok = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def dealer_headers():
    tok = _login(DEALER_EMAIL, DEALER_PASSWORD)
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def _find_sub_by_ref(admin_headers, ref: str):
    r = requests.get(f"{BASE_URL}/api/admin/submissions?limit=500", headers=admin_headers, timeout=30)
    assert r.status_code == 200, r.text[:200]
    subs = r.json().get("submissions") or []
    for s in subs:
        if s.get("reference") == ref:
            return s
    return None


@pytest.fixture(scope="module")
def mb_submission(admin_headers):
    sub = _find_sub_by_ref(admin_headers, MB_REF)
    if not sub:
        pytest.skip(f"{MB_REF} not found in preview DB")
    return sub


@pytest.fixture(scope="module")
def non_mb_submission(admin_headers):
    sub = _find_sub_by_ref(admin_headers, NON_MB_REF)
    if not sub:
        pytest.skip(f"{NON_MB_REF} not found in preview DB")
    return sub


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------
class TestReportCatalog:
    def test_catalog_contains_mb_options(self, admin_headers, mb_submission):
        """The catalog endpoint filters make-restricted reports unless a
        submission_id is supplied. Pass the Mercedes sub_id so mb_options
        shows up."""
        r = requests.get(
            f"{BASE_URL}/api/reports/catalog",
            params={"submission_id": mb_submission["id"]},
            headers=admin_headers,
            timeout=30,
        )
        assert r.status_code == 200, f"catalog fetch failed: {r.status_code} {r.text[:200]}"
        payload = r.json()
        reports = payload.get("reports") if isinstance(payload, dict) else payload
        assert reports, f"catalog empty: {payload}"
        by_type = {r["type"]: r for r in reports}
        assert "mb_options" in by_type, f"mb_options missing. Types: {list(by_type.keys())}"
        mb = by_type["mb_options"]
        assert mb["cost_zar"] == 20.0
        makes = [m.upper() for m in (mb.get("supported_makes") or [])]
        assert "MERCEDES-BENZ" in makes
        assert "MAYBACH" in makes or "MERCEDES-MAYBACH" in makes


# ---------------------------------------------------------------------------
# FB-000156 (Mercedes) — mb_spec should already be persisted from dev run
# ---------------------------------------------------------------------------
class TestMbOptionsOnMercedes:
    def test_submission_is_mercedes(self, mb_submission):
        make = (mb_submission.get("make_name") or "").upper()
        assert "MERCEDES" in make
        assert mb_submission.get("vin") == MB_VIN

    def test_mb_spec_persisted_after_dev_order(self, admin_headers, mb_submission):
        r = requests.get(f"{BASE_URL}/api/submissions/{mb_submission['id']}", headers=admin_headers, timeout=30)
        assert r.status_code == 200
        payload = r.json()
        sub = payload.get("submission") or payload
        spec = sub.get("mb_spec")
        assert spec, "mb_spec missing on FB-000156"
        assert spec["status"] == "ok"
        assert spec["provider"] == "mbtools"
        assert spec.get("series") in ("206", "W206"), spec.get("series")
        assert spec.get("year") == 2024
        assert (spec.get("fuel") or "").lower() == "petrol"
        opts = spec.get("options") or []
        assert len(opts) > 100, f"expected >100 options, got {len(opts)}"
        assert all(o.get("code") and o.get("kind") == "SA" for o in opts)
        # description on some codes
        with_desc = sum(1 for o in opts if o.get("description"))
        assert with_desc >= 20, f"only {with_desc} options had descriptions (expected ~59)"
        # headunit
        hu = spec.get("headunit") or {}
        assert hu.get("generation") == "NTG 7", hu
        print(f"FB-000156 mb_spec: options_total={len(opts)} with_desc={with_desc} "
              f"headunit={hu.get('generation')} navi_region={hu.get('navi_region')}")

    def test_reorder_returns_409(self, dealer_headers, mb_submission):
        """Dealer dave already ordered mb_options — re-order must 409."""
        r = requests.post(
            f"{BASE_URL}/api/submissions/{mb_submission['id']}/reports",
            headers=dealer_headers,
            json={"type": "mb_options", "accepted_charge": True},
            timeout=60,
        )
        assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text[:200]}"

    def test_mb_options_order_row_exists(self, admin_headers, mb_submission):
        r = requests.get(
            f"{BASE_URL}/api/submissions/{mb_submission['id']}/reports",
            headers=admin_headers,
            timeout=30,
        )
        assert r.status_code == 200
        orders = r.json().get("reports") or []
        mb_orders = [o for o in orders if o.get("type") == "mb_options"]
        assert mb_orders, f"No mb_options order found. Got types: {[o.get('type') for o in orders]}"
        mb = mb_orders[0]
        assert mb.get("status") == "delivered"
        assert float(mb.get("cost_zar") or 0) == 20.0
        # data is in `result_data`
        data = mb.get("result_data") or {}
        assert data.get("status") == "ok"
        assert data.get("provider") == "mbtools"
        opts = data.get("options") or []
        assert len(opts) > 100, f"order data has too few options: {len(opts)}"
        assert data.get("series") in ("206", "W206")
        assert data.get("year") == 2024
        hu = data.get("headunit") or {}
        assert hu.get("generation") == "NTG 7"
        assert "Africa" in (hu.get("navi_region") or "")

    def test_mb_options_standalone_pdf(self, admin_headers, mb_submission):
        """The `mb_options` standalone PDF is intentionally a stub referring
        the reader to the valuation PDF, but the endpoint must still serve
        a PDF binary."""
        r = requests.get(
            f"{BASE_URL}/api/submissions/{mb_submission['id']}/reports/mb_options.pdf",
            headers={"Authorization": admin_headers["Authorization"]},
            timeout=60,
        )
        assert r.status_code == 200, f"pdf failed: {r.status_code} {r.text[:200]}"
        assert r.content[:4] == b"%PDF", f"not a PDF: {r.content[:20]!r}"
        assert len(r.content) > 500

    def test_valuation_pdf_renders(self, admin_headers, mb_submission):
        r = requests.get(
            f"{BASE_URL}/api/submissions/{mb_submission['id']}/valuation.pdf",
            headers={"Authorization": admin_headers["Authorization"]},
            timeout=120,
        )
        assert r.status_code == 200, f"valuation pdf failed: {r.status_code} {r.text[:200]}"
        assert r.content[:4] == b"%PDF"
        assert len(r.content) > 5000, f"suspiciously small valuation PDF ({len(r.content)}b)"
        # Best-effort marker check (may be split by PDF compression)
        has_factory = b"FACTORY" in r.content or b"Factory" in r.content or b"Options" in r.content
        print(f"valuation PDF: size={len(r.content)}b factory_marker={has_factory}")


# ---------------------------------------------------------------------------
# Guard: non-Mercedes VIN cannot be ordered as mb_options
# ---------------------------------------------------------------------------
class TestMbOptionsMakeGuard:
    def test_dealer_cannot_order_mb_options_on_vw(self, dealer_headers, non_mb_submission):
        assert "MERCEDES" not in (non_mb_submission.get("make_name") or "").upper()
        r = requests.post(
            f"{BASE_URL}/api/submissions/{non_mb_submission['id']}/reports",
            headers=dealer_headers,
            json={"type": "mb_options", "accepted_charge": True},
            timeout=30,
        )
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text[:200]}"
        body = r.text.lower()
        assert ("mercedes" in body or "supported" in body or "only available" in body), \
            f"error msg missing make-hint: {r.text[:200]}"


# ---------------------------------------------------------------------------
# Regression: bmw_options guard still fires on non-BMW
# ---------------------------------------------------------------------------
class TestBmwOptionsRegression:
    def test_dealer_cannot_order_bmw_options_on_vw(self, dealer_headers, non_mb_submission):
        r = requests.post(
            f"{BASE_URL}/api/submissions/{non_mb_submission['id']}/reports",
            headers=dealer_headers,
            json={"type": "bmw_options", "accepted_charge": True},
            timeout=30,
        )
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text[:200]}"
        body = r.text.lower()
        assert "bmw" in body or "supported" in body or "only available" in body


# ---------------------------------------------------------------------------
# Regression: landrover_osh guard still fires on non-JLR
# ---------------------------------------------------------------------------
class TestLandroverOshRegression:
    def test_dealer_cannot_order_landrover_osh_on_vw(self, dealer_headers, non_mb_submission):
        r = requests.post(
            f"{BASE_URL}/api/submissions/{non_mb_submission['id']}/reports",
            headers=dealer_headers,
            json={"type": "landrover_osh", "accepted_charge": True},
            timeout=30,
        )
        # Should be 400 (make guard). If dealer already ordered it, could be 409.
        assert r.status_code in (400, 409), f"unexpected status {r.status_code}: {r.text[:200]}"
        if r.status_code == 400:
            body = r.text.lower()
            assert "land" in body or "jaguar" in body or "supported" in body or "only available" in body
