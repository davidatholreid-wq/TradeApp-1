"""
Phase 3 backend tests for Fourbuy Car Buying Co.
Covers:
- Auto-generated vehicle reference numbers (FB-000001 format)
- Sequential monotonically increasing references
- Reference field exposure on GET my/admin/single
- Admin DELETE submission (200, 403 dealer, 404 invalid)
- POST /api/submissions/{id}/market-analysis (owner, admin, non-owner, missing sub)
- market_analysis persisted on GET /api/submissions/{id}
"""
import os
import re
import uuid
import base64
import pytest
import requests

BASE_URL = os.environ.get(
    "EXPO_BACKEND_URL",
    "https://fourbuy-admin.preview.emergentagent.com",
).rstrip("/")
API = f"{BASE_URL}/api"

# Prefer the fourbuy admin per test_credentials.md
ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"

REF_PATTERN = re.compile(r"^FB-\d{6}$")

TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/aQ2sAAAAASUVORK5CYII="
)


# ---------- Fixtures ----------
@pytest.fixture(scope="session")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


def _register_dealer(s, tag: str) -> dict:
    email = f"phase3_{tag}_{uuid.uuid4().hex[:8]}@example.com"
    payload = {
        "email": email,
        "password": "Dealer123!",
        "dealer_info": {
            "first_name": "Phase3",
            "last_name": tag.capitalize(),
            "phone": "0821234567",
        },
        "company_info": {
            "company_name": f"TEST_Phase3_{tag}",
            "company_address": "1 Test Rd, JHB",
        },
    }
    r = s.post(f"{API}/auth/register", json=payload)
    assert r.status_code == 200, f"Register failed: {r.status_code} {r.text}"
    data = r.json()
    return {
        "token": data["token"],
        "id": data["user"]["id"],
        "email": data["user"]["email"],
    }


@pytest.fixture(scope="session")
def admin_token(s):
    r = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def dealer_a(s):
    return _register_dealer(s, "owner")


@pytest.fixture(scope="session")
def dealer_b(s):
    """Second dealer - used to test 403 on other dealer's submission."""
    return _register_dealer(s, "other")


@pytest.fixture(scope="session")
def vehicle_ids(s):
    r = s.get(f"{API}/vehicles/makes")
    assert r.status_code == 200
    make = r.json()["makes"][0]
    r2 = s.get(f"{API}/vehicles/models", params={"make_id": make["id"]})
    model = r2.json()["models"][0]
    r3 = s.get(f"{API}/vehicles/derivatives", params={"model_id": model["id"]})
    deriv = r3.json()["derivatives"][0]
    return {"make": make, "model": model, "derivative": deriv}


def _submission_payload(v: dict) -> dict:
    return {
        "make_id": v["make"]["id"],
        "make_name": v["make"]["name"],
        "model_id": v["model"]["id"],
        "model_name": v["model"]["name"],
        "derivative_id": v["derivative"]["id"],
        "derivative_name": v["derivative"]["name"],
        "mileage": 55000,
        "year": 2020,
        "factory_warranty": True,
        "condition": 8,
        "accident_damage": False,
        "colour": "White",
        "license_disk_data": None,
        "photos": {
            "front": TINY_PNG_B64,
            "side_right": TINY_PNG_B64,
            "rear": TINY_PNG_B64,
            "side_left": TINY_PNG_B64,
            "interior": TINY_PNG_B64,
        },
    }


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------- Reference number tests ----------
class TestReferenceNumbers:
    def test_create_submission_returns_reference_field(self, s, dealer_a, vehicle_ids):
        r = s.post(
            f"{API}/submissions",
            json=_submission_payload(vehicle_ids),
            headers=_auth(dealer_a["token"]),
        )
        assert r.status_code == 200, r.text
        data = r.json()
        sub = data["submission"]
        assert "reference" in sub, "Missing 'reference' field in submission"
        assert REF_PATTERN.match(sub["reference"]), f"Bad reference format: {sub['reference']}"
        # Persist for downstream tests
        pytest.first_ref = sub["reference"]
        pytest.first_sub_id = sub["id"]

    def test_sequential_references_increment(self, s, dealer_a, vehicle_ids):
        refs = []
        ids = []
        for _ in range(3):
            r = s.post(
                f"{API}/submissions",
                json=_submission_payload(vehicle_ids),
                headers=_auth(dealer_a["token"]),
            )
            assert r.status_code == 200, r.text
            sub = r.json()["submission"]
            assert REF_PATTERN.match(sub["reference"])
            refs.append(int(sub["reference"].split("-")[1]))
            ids.append(sub["id"])
        # Each subsequent ref must be strictly greater than the previous
        for i in range(1, len(refs)):
            assert refs[i] > refs[i - 1], f"Refs not monotonic: {refs}"
        # And they should be 1 apart (no interleaving in this session)
        for i in range(1, len(refs)):
            assert refs[i] - refs[i - 1] >= 1
        pytest.extra_sub_ids = ids

    def test_my_submissions_include_reference(self, s, dealer_a):
        r = s.get(f"{API}/submissions/my", headers=_auth(dealer_a["token"]))
        assert r.status_code == 200, r.text
        subs = r.json()["submissions"]
        assert len(subs) > 0
        for sub in subs:
            assert "reference" in sub, f"submission missing reference: {sub.get('id')}"
            assert REF_PATTERN.match(sub["reference"]), f"Bad ref format: {sub['reference']}"

    def test_admin_submissions_include_reference(self, s, admin_token):
        r = s.get(f"{API}/admin/submissions", headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        subs = r.json()["submissions"]
        assert len(subs) > 0
        # Every returned submission must have a valid reference
        bad = [s for s in subs if not (s.get("reference") and REF_PATTERN.match(s["reference"]))]
        assert not bad, f"{len(bad)} submissions missing/invalid reference"

    def test_get_single_submission_has_ref_and_market_fields(self, s, admin_token):
        sub_id = pytest.first_sub_id
        r = s.get(f"{API}/submissions/{sub_id}", headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        sub = r.json()["submission"]
        assert sub.get("reference") == pytest.first_ref
        # Must expose (possibly null) market fields
        assert "market_analysis" in sub
        assert "market_analysis_at" in sub


# ---------- Admin DELETE submission ----------
class TestAdminDeleteSubmission:
    def test_dealer_cannot_delete(self, s, dealer_a):
        sub_id = pytest.extra_sub_ids[0]
        r = s.delete(f"{API}/admin/submissions/{sub_id}", headers=_auth(dealer_a["token"]))
        assert r.status_code == 403, f"Expected 403, got {r.status_code}: {r.text}"

    def test_admin_delete_succeeds(self, s, admin_token):
        sub_id = pytest.extra_sub_ids[0]
        r = s.delete(f"{API}/admin/submissions/{sub_id}", headers=_auth(admin_token))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("status") == "deleted"
        # GET should now 404
        r2 = s.get(f"{API}/submissions/{sub_id}", headers=_auth(admin_token))
        assert r2.status_code == 404

    def test_admin_delete_invalid_id_returns_404(self, s, admin_token):
        bogus = f"nope-{uuid.uuid4().hex}"
        r = s.delete(f"{API}/admin/submissions/{bogus}", headers=_auth(admin_token))
        assert r.status_code == 404, f"Expected 404, got {r.status_code}: {r.text}"


# ---------- Market Analysis (AI) ----------
class TestMarketAnalysis:
    def _validate_analysis_payload(self, payload: dict):
        assert "analysis" in payload
        assert "generated_at" in payload
        assert payload.get("model") == "gpt-5.2", f"model={payload.get('model')}"
        analysis = payload["analysis"]
        assert isinstance(analysis, dict)
        structured_keys = {
            "estimated_market_range_zar",
            "trade_price_estimate_zar",
            "retail_price_estimate_zar",
            "listings_summary",
            "key_factors",
        }
        has_structured = bool(structured_keys.intersection(analysis.keys()))
        has_raw = "raw" in analysis
        assert has_structured or has_raw, f"Neither structured nor raw fallback: keys={list(analysis.keys())}"

    def test_owner_dealer_can_generate(self, s, dealer_a):
        sub_id = pytest.first_sub_id
        r = s.post(
            f"{API}/submissions/{sub_id}/market-analysis",
            headers=_auth(dealer_a["token"]),
            timeout=120,
        )
        assert r.status_code == 200, f"Owner market-analysis failed: {r.status_code} {r.text[:400]}"
        payload = r.json()
        self._validate_analysis_payload(payload)

    def test_other_dealer_forbidden(self, s, dealer_b):
        sub_id = pytest.first_sub_id
        r = s.post(
            f"{API}/submissions/{sub_id}/market-analysis",
            headers=_auth(dealer_b["token"]),
        )
        assert r.status_code == 403, f"Expected 403 for non-owner dealer, got {r.status_code}: {r.text[:200]}"

    def test_admin_can_generate(self, s, admin_token, dealer_a, vehicle_ids):
        # Create a fresh submission owned by dealer_a but analysed by admin
        r_create = s.post(
            f"{API}/submissions",
            json=_submission_payload(vehicle_ids),
            headers=_auth(dealer_a["token"]),
        )
        assert r_create.status_code == 200
        sub_id = r_create.json()["submission"]["id"]

        r = s.post(
            f"{API}/submissions/{sub_id}/market-analysis",
            headers=_auth(admin_token),
            timeout=120,
        )
        assert r.status_code == 200, f"Admin market-analysis failed: {r.status_code} {r.text[:400]}"
        self._validate_analysis_payload(r.json())
        pytest.admin_analysis_sub_id = sub_id

    def test_market_analysis_persisted_on_get(self, s, admin_token):
        sub_id = pytest.first_sub_id
        r = s.get(f"{API}/submissions/{sub_id}", headers=_auth(admin_token))
        assert r.status_code == 200
        sub = r.json()["submission"]
        ma = sub.get("market_analysis")
        assert ma is not None, "market_analysis not persisted after POST"
        assert ma.get("model") == "gpt-5.2"
        assert sub.get("market_analysis_at") is not None

    def test_missing_submission_returns_404(self, s, admin_token):
        bogus = f"missing-{uuid.uuid4().hex}"
        r = s.post(
            f"{API}/submissions/{bogus}/market-analysis",
            headers=_auth(admin_token),
        )
        assert r.status_code == 404, f"Expected 404, got {r.status_code}"
