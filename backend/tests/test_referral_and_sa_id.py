"""
Backend tests for the SA ID + Referral Code + Referral Rewards feature set.

Covers:
- SA ID validation in POST /api/admin/dealerships/{id}/users
- Referral code auto-generation on user creation
- referred_by_code linking to another dealer
- GET /api/referral/lookup (public, no auth)
- Lazy /api/auth/me referral_code allocation for pre-existing dealers
- Referral reward hook: referrer receives referral_earn on referee's priced sub
- Idempotency on double-price
- No car details leaked on referral_earn ledger row
- /api/rewards/me totals: earned includes referral, `referred` is new
"""
import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"

MINITEST_EMAIL = "minitest@example.com"
MINITEST_PASSWORD = "Mini1234!"

FORD_BRYANSTON_ID = "5b5cd0c6-3f06-45c4-8067-52c40f0c92bf"

# Known-good SA IDs (valid Luhn) - one for A, one for B
# NOTE: user's suggested "9202204720082" is NOT actually Luhn-valid under this
# implementation; the correct check digit for that prefix is 3.
SA_ID_VALID_A = "9202204720083"  # 1992-02-20 female SA citizen, Luhn ok
SA_ID_VALID_B = "8501015009086"  # 1985-01-01 male SA citizen, Luhn ok
SA_ID_BAD_LUHN = "9202204720081"
SA_ID_BAD_DATE = "9902324720085"
SA_ID_SHORT = "1234567890"


# ---------- session ----------
@pytest.fixture(scope="session")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="session")
def admin_token(s):
    r = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


def _admin_hdr(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def _dealer_hdr(tok):
    return {"Authorization": f"Bearer {tok}"}


def _random_email(tag="ref"):
    return f"TEST_{tag}_{uuid.uuid4().hex[:8]}@example.com"


def _invite_payload(email, sa_id=SA_ID_VALID_A, referred_by_code=None, fn="Test", ln="Referrer"):
    p = {
        "email": email,
        "password": "TestPass123!",
        "dealer_info": {
            "first_name": fn,
            "last_name": ln,
            "phone": "0821234567",
        },
        "active": True,
        "sa_id_number": sa_id,
    }
    if referred_by_code is not None:
        p["referred_by_code"] = referred_by_code
    return p


# ============ SA ID validation tests ============
class TestSAIDValidation:
    """Server-side SA ID validation on the admin invite endpoint."""

    def test_valid_sa_id_creates_user_with_referral_code(self, s, admin_token):
        email = _random_email("said_ok")
        r = s.post(
            f"{API}/admin/dealerships/{FORD_BRYANSTON_ID}/users",
            json=_invite_payload(email, sa_id=SA_ID_VALID_A),
            headers=_admin_hdr(admin_token),
        )
        assert r.status_code == 200, r.text
        u = r.json()["user"]
        assert u["sa_id_number"] == SA_ID_VALID_A
        assert u["referral_code"], "referral_code should be auto-assigned"
        assert len(u["referral_code"]) == 6
        assert u["referral_code"].isalnum() and u["referral_code"].isupper()

    def test_missing_sa_id_rejected(self, s, admin_token):
        payload = _invite_payload(_random_email("miss"))
        payload.pop("sa_id_number", None)
        r = s.post(
            f"{API}/admin/dealerships/{FORD_BRYANSTON_ID}/users",
            json=payload,
            headers=_admin_hdr(admin_token),
        )
        # Pydantic will return 422 on missing required field
        assert r.status_code in (400, 422), r.text

    def test_short_sa_id_rejected(self, s, admin_token):
        r = s.post(
            f"{API}/admin/dealerships/{FORD_BRYANSTON_ID}/users",
            json=_invite_payload(_random_email("short"), sa_id=SA_ID_SHORT),
            headers=_admin_hdr(admin_token),
        )
        assert r.status_code == 400, r.text
        assert "13" in r.text

    def test_invalid_luhn_now_accepted(self, s, admin_token):
        """Luhn checksum enforcement was intentionally removed to reduce
        false rejections on legacy IDs. A bad-Luhn ID with a valid DoB
        should now be accepted."""
        r = s.post(
            f"{API}/admin/dealerships/{FORD_BRYANSTON_ID}/users",
            json=_invite_payload(_random_email("luhn"), sa_id=SA_ID_BAD_LUHN),
            headers=_admin_hdr(admin_token),
        )
        assert r.status_code == 200, r.text

    def test_invalid_date_rejected(self, s, admin_token):
        r = s.post(
            f"{API}/admin/dealerships/{FORD_BRYANSTON_ID}/users",
            json=_invite_payload(_random_email("date"), sa_id=SA_ID_BAD_DATE),
            headers=_admin_hdr(admin_token),
        )
        assert r.status_code == 400, r.text
        assert "date" in r.text.lower() or "birth" in r.text.lower()


# ============ Referral lookup + lazy code ============
class TestReferralLookupAndLazyCode:

    def test_minitest_gets_lazy_referral_code(self, s):
        r = s.post(f"{API}/auth/login", json={"email": MINITEST_EMAIL, "password": MINITEST_PASSWORD})
        if r.status_code != 200:
            pytest.skip(f"minitest login failed: {r.status_code} {r.text}")
        tok = r.json()["token"]
        # First /auth/me — should populate referral_code
        me1 = s.get(f"{API}/auth/me", headers=_dealer_hdr(tok))
        assert me1.status_code == 200, me1.text
        code1 = me1.json()["user"].get("referral_code")
        assert code1, "referral_code should be lazily generated on /auth/me"
        assert len(code1) == 6
        # Second call — SAME code (persisted)
        me2 = s.get(f"{API}/auth/me", headers=_dealer_hdr(tok))
        assert me2.status_code == 200
        assert me2.json()["user"].get("referral_code") == code1

    def test_public_referral_lookup(self, s):
        # First get minitest's code
        lr = s.post(f"{API}/auth/login", json={"email": MINITEST_EMAIL, "password": MINITEST_PASSWORD})
        if lr.status_code != 200:
            pytest.skip("minitest login failed")
        tok = lr.json()["token"]
        me = s.get(f"{API}/auth/me", headers=_dealer_hdr(tok)).json()["user"]
        code = me.get("referral_code")
        assert code

        # Public — NO auth header. Use a fresh session to make sure.
        pub = requests.Session()
        r = pub.get(f"{API}/referral/lookup", params={"code": code})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["code"] == code
        assert d["referrer_name"], "referrer_name expected"
        # dealership name — should be Mini Test Motors (may be None if minitest
        # not attached to a dealership; still not a hard requirement)
        assert "referrer_dealership" in d

    def test_public_referral_lookup_unknown_404(self, s):
        pub = requests.Session()
        r = pub.get(f"{API}/referral/lookup", params={"code": "ZZZZZZ"})
        assert r.status_code == 404, r.text


# ============ Referrer linking on invite ============
class TestReferredByOnInvite:

    def test_invite_with_valid_referred_by_code(self, s, admin_token):
        # 1. Create referrer A
        email_a = _random_email("refA")
        rA = s.post(
            f"{API}/admin/dealerships/{FORD_BRYANSTON_ID}/users",
            json=_invite_payload(email_a, sa_id=SA_ID_VALID_A, fn="Alice", ln="Referrer"),
            headers=_admin_hdr(admin_token),
        )
        assert rA.status_code == 200, rA.text
        A = rA.json()["user"]
        code_A = A["referral_code"]
        # 2. Create referee B using A's code
        email_b = _random_email("refB")
        rB = s.post(
            f"{API}/admin/dealerships/{FORD_BRYANSTON_ID}/users",
            json=_invite_payload(email_b, sa_id=SA_ID_VALID_B, referred_by_code=code_A, fn="Bob", ln="Referee"),
            headers=_admin_hdr(admin_token),
        )
        assert rB.status_code == 200, rB.text
        B = rB.json()["user"]
        assert B["referred_by_code"] == code_A
        assert B["referred_by_user_id"] == A["id"]

    def test_invite_with_unknown_referred_by_code_rejected(self, s, admin_token):
        r = s.post(
            f"{API}/admin/dealerships/{FORD_BRYANSTON_ID}/users",
            json=_invite_payload(_random_email("badref"), sa_id=SA_ID_VALID_A, referred_by_code="NOPE99"),
            headers=_admin_hdr(admin_token),
        )
        assert r.status_code == 400, r.text
        assert "referral code" in r.text.lower() or "does not match" in r.text.lower()


# ============ Referral rewards E2E ============
def _tiny_b64():
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="


def _accept_agreement(s, token):
    s.post(f"{API}/agreement/accept", headers=_dealer_hdr(token))


def _login(s, email, password):
    r = s.post(f"{API}/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _submit_vehicle(s, token):
    makes = s.get(f"{API}/vehicles/makes").json()["makes"]
    toyota = next(m for m in makes if m["name"] == "Toyota")
    models = s.get(f"{API}/vehicles/models", params={"make_id": toyota["id"]}).json()["models"]
    hilux = next(m for m in models if m["name"] == "Hilux")
    derivs = s.get(f"{API}/vehicles/derivatives", params={"model_id": hilux["id"]}).json()["derivatives"]
    deriv = derivs[0]
    photo = _tiny_b64()
    payload = {
        "make_id": toyota["id"], "make_name": "Toyota",
        "model_id": hilux["id"], "model_name": "Hilux",
        "derivative_id": deriv["id"], "derivative_name": deriv["name"],
        "make": "Toyota", "model": "Hilux", "derivative": deriv["name"],
        "fuel_type": "Diesel", "transmission": "Manual",
        "year_of_production": 2020, "year_registered": 2020,
        "mileage": 55000, "colour": "White",
        "mechanical_condition": 8, "cosmetic_condition": 8,
        "interior_condition": 8, "history_condition": 8,
        "windscreen_condition": "Perfect",
        "service_history": "Full Service History with Agents",
        "paint_evidence": False, "accident_damage": False, "factory_warranty": True,
        "license_disk_data": "%TEST%LICENSE_DISK%DATA%",
        "photos": {"front": photo, "driver_side": photo, "passenger_side": photo, "rear": photo, "interior": photo},
        "billing_accepted": True,
    }
    r = s.post(f"{API}/submissions", json=payload, headers=_dealer_hdr(token))
    assert r.status_code == 200, r.text
    body = r.json()
    return {"id": body["id"], "reference": body["submission"].get("reference")}


class TestReferralRewards:
    """End-to-end: A refers B, B submits + priced -> A gets referral_earn."""

    @pytest.fixture(scope="class")
    def linked_pair(self, s, admin_token):
        email_a = _random_email("earnA")
        rA = s.post(
            f"{API}/admin/dealerships/{FORD_BRYANSTON_ID}/users",
            json=_invite_payload(email_a, sa_id=SA_ID_VALID_A, fn="Anna", ln="Earn"),
            headers=_admin_hdr(admin_token),
        )
        assert rA.status_code == 200, rA.text
        A = rA.json()["user"]
        email_b = _random_email("earnB")
        rB = s.post(
            f"{API}/admin/dealerships/{FORD_BRYANSTON_ID}/users",
            json=_invite_payload(email_b, sa_id=SA_ID_VALID_B, referred_by_code=A["referral_code"], fn="Ben", ln="Earn"),
            headers=_admin_hdr(admin_token),
        )
        assert rB.status_code == 200, rB.text
        return {
            "A": {"user": A, "email": email_a, "password": "TestPass123!"},
            "B": {"user": rB.json()["user"], "email": email_b, "password": "TestPass123!"},
        }

    def test_full_referral_reward_flow(self, s, admin_token, linked_pair):
        A = linked_pair["A"]
        B = linked_pair["B"]

        # A snapshot of pre-existing referral ledger
        tokA = _login(s, A["email"], A["password"])
        pre = s.get(f"{API}/rewards/me", headers=_dealer_hdr(tokA))
        assert pre.status_code == 200, pre.text
        pre_referred = pre.json()["totals"].get("referred", 0)
        pre_balance = pre.json()["balance"]

        # B logs in, accepts agreement, submits vehicle
        tokB = _login(s, B["email"], B["password"])
        _accept_agreement(s, tokB)
        sub = _submit_vehicle(s, tokB)
        sub_id = sub["id"]
        reference = sub["reference"]

        # Admin prices it
        r_price = s.post(
            f"{API}/admin/submissions/{sub_id}/price",
            json={"price": 250000, "notes": "TEST referral price"},
            headers=_admin_hdr(admin_token),
        )
        assert r_price.status_code == 200, r_price.text

        # Fetch A's rewards
        post = s.get(f"{API}/rewards/me", headers=_dealer_hdr(tokA))
        assert post.status_code == 200, post.text
        pdata = post.json()
        assert pdata["totals"]["referred"] == pre_referred + 1, f"Expected referred+1, got {pdata['totals']}"
        assert pdata["balance"] == pre_balance + 1
        # Find the referral_earn row
        ref_rows = [e for e in pdata["ledger"] if e.get("type") == "referral_earn" and e.get("sub_id") == sub_id]
        assert len(ref_rows) == 1, f"Expected exactly one referral_earn row, got {ref_rows}"
        row = ref_rows[0]
        assert row["delta"] == 1
        assert row.get("referral_of_reference") == reference
        # NO car details leaked
        row_str = str(row).lower()
        for banned in ["toyota", "hilux", "white", "diesel"]:
            assert banned not in row_str, f"Car detail '{banned}' leaked into referral row: {row}"

        # Also assert whole response doesn't leak car details in referral rows
        for e in pdata["ledger"]:
            if e.get("type") == "referral_earn":
                s_e = str(e).lower()
                for banned in ["toyota", "hilux", "make", "model_name", "derivative", "colour"]:
                    # 'model' actually appears inside legitimate key names? our ledger row shouldn't have it.
                    # Check car-detail values, not schema keys
                    if banned in ("make", "model_name", "derivative", "colour"):
                        # These are keys we want NOT present
                        assert banned not in e.keys(), f"Ledger row has forbidden key '{banned}': {e}"
                    else:
                        assert banned not in s_e, f"Car detail '{banned}' leaked: {e}"

        # Idempotency: price again, referrer should NOT gain another point
        r_price2 = s.post(
            f"{API}/admin/submissions/{sub_id}/price",
            json={"price": 260000, "notes": "TEST re-price for idempotency", "change_comment": "bump"},
            headers=_admin_hdr(admin_token),
        )
        assert r_price2.status_code == 200, r_price2.text

        post2 = s.get(f"{API}/rewards/me", headers=_dealer_hdr(tokA))
        pdata2 = post2.json()
        ref_rows2 = [e for e in pdata2["ledger"] if e.get("type") == "referral_earn" and e.get("sub_id") == sub_id]
        assert len(ref_rows2) == 1, f"Idempotency broken — {len(ref_rows2)} referral_earn rows after 2nd price"
        assert pdata2["totals"]["referred"] == pre_referred + 1
        assert pdata2["balance"] == pre_balance + 1

    def test_rewards_me_totals_shape(self, s, admin_token, linked_pair):
        """Verify totals.earned includes referral_earn and totals.referred exists."""
        A = linked_pair["A"]
        tokA = _login(s, A["email"], A["password"])
        r = s.get(f"{API}/rewards/me", headers=_dealer_hdr(tokA))
        assert r.status_code == 200
        d = r.json()
        assert "referred" in d["totals"], "totals.referred missing"
        # earned must include referral_earn — since we haven't submitted from A directly,
        # earned should equal referred here.
        assert d["totals"]["earned"] >= d["totals"]["referred"]
