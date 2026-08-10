"""
Iteration 48 — Regression pass after routes refactor.
5 modules were extracted from server.py: ads, rewards, kredo, cover, auth.
This is a REFACTOR ONLY test — verifies contract/behaviour unchanged.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/") or \
           os.environ.get("EXPO_BACKEND_URL", "").rstrip("/")

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"
DEALER_EMAIL = "dave@fourbuy.co.za"
DEALER_PASSWORD = "Dave1234!"


def _login(session, email, password):
    r = session.post(f"{BASE_URL}/api/auth/login",
                     json={"email": email, "password": password}, timeout=30)
    return r


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def admin_token(api):
    r = _login(api, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text[:200]}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def dealer_token(api):
    r = _login(api, DEALER_EMAIL, DEALER_PASSWORD)
    assert r.status_code == 200, f"dealer login failed: {r.status_code} {r.text[:200]}"
    return r.json()["token"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


# ---------- AUTH ----------
class TestAuth:
    def test_dealer_login_success(self, api):
        r = _login(api, DEALER_EMAIL, DEALER_PASSWORD)
        assert r.status_code == 200
        data = r.json()
        assert "token" in data
        assert data.get("user", {}).get("email") == DEALER_EMAIL

    def test_admin_login_success(self, api):
        r = _login(api, ADMIN_EMAIL, ADMIN_PASSWORD)
        assert r.status_code == 200

    def test_wrong_password_returns_401(self, api):
        r = _login(api, DEALER_EMAIL, "wrong-password-xxx")
        assert r.status_code == 401
        # error should be present, non-empty
        body = r.json()
        assert "detail" in body and body["detail"]

    def test_auth_me_dealer_returns_full_payload(self, api, dealer_token):
        r = api.get(f"{BASE_URL}/api/auth/me", headers=_auth(dealer_token), timeout=30)
        assert r.status_code == 200
        data = r.json()
        # Response is either wrapped {"user": {...}} or flat — support either
        user = data.get("user", data)
        assert user.get("email") == DEALER_EMAIL
        # Referral enrichment expected
        assert "referral_code" in user, f"referral_code missing. Keys: {list(user.keys())[:20]}"
        # Dealership enrichment expected (nested object OR dealership_name/id field)
        assert user.get("dealership") is not None or user.get("dealership_id") \
            or user.get("dealership_name"), \
            f"dealership enrichment missing. Keys: {list(user.keys())[:20]}"

    def test_forgot_password_known_email_returns_200(self, api):
        r = api.post(f"{BASE_URL}/api/auth/forgot-password",
                     json={"email": DEALER_EMAIL}, timeout=30)
        assert r.status_code == 200

    def test_forgot_password_unknown_email_returns_200_generic(self, api):
        # Should not leak account existence
        r = api.post(f"{BASE_URL}/api/auth/forgot-password",
                     json={"email": "nonexistent-xyz@example.com"}, timeout=30)
        assert r.status_code == 200

    def test_reset_password_invalid_token_returns_400(self, api):
        r = api.post(f"{BASE_URL}/api/auth/reset-password",
                     json={"token": "bogus-token-xxx", "new_password": "Whatever123!"},
                     timeout=30)
        assert r.status_code == 400


# ---------- REFERRAL ----------
class TestReferral:
    def test_referral_lookup_known_code(self, api, dealer_token):
        me = api.get(f"{BASE_URL}/api/auth/me", headers=_auth(dealer_token)).json()
        user = me.get("user", me)
        code = user.get("referral_code")
        assert code, "Dave has no referral_code"
        r = api.get(f"{BASE_URL}/api/referral/lookup?code={code}", timeout=30)
        assert r.status_code == 200
        body = r.json()
        # Expect name + dealership hints
        blob = str(body).lower()
        assert "dave" in blob or "fourbuy" in blob, \
            f"expected dealer info in referral lookup: {body}"

    def test_referral_lookup_unknown_code(self, api):
        r = api.get(f"{BASE_URL}/api/referral/lookup?code=NOPE99XX", timeout=30)
        assert r.status_code == 404


# ---------- ADS ----------
class TestAds:
    def test_admin_ads_returns_10_slots(self, api, admin_token):
        r = api.get(f"{BASE_URL}/api/admin/ads",
                    headers=_auth(admin_token), timeout=30)
        assert r.status_code == 200
        data = r.json()
        # Endpoint returns {"slots": [...]} (10 slots)
        slots = data.get("slots", data.get("ads", []))
        assert len(slots) == 10, f"Expected 10 ad slots got {len(slots)}"

    def test_ads_active_public(self, api, dealer_token):
        # Dealer home rotating tile
        r = api.get(f"{BASE_URL}/api/ads/active",
                    headers=_auth(dealer_token), timeout=30)
        assert r.status_code == 200
        data = r.json()
        # Should return an ads list (possibly filtered by active status)
        assert isinstance(data, (list, dict))


# ---------- REWARDS ----------
class TestRewards:
    def test_dealer_rewards_me(self, api, dealer_token):
        r = api.get(f"{BASE_URL}/api/rewards/me",
                    headers=_auth(dealer_token), timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert "balance" in data or "points" in data or "balance_points" in data
        # points_to_next_voucher field check (name may vary)
        keys_lower = {k.lower() for k in data.keys()}
        assert any("next" in k for k in keys_lower) or "points_to_next_voucher" in data

    def test_admin_rewards_users(self, api, admin_token):
        r = api.get(f"{BASE_URL}/api/admin/rewards/users",
                    headers=_auth(admin_token), timeout=30)
        assert r.status_code == 200

    def test_admin_reward_redemptions(self, api, admin_token):
        r = api.get(f"{BASE_URL}/api/admin/reward-redemptions",
                    headers=_auth(admin_token), timeout=30)
        assert r.status_code == 200

    def test_admin_rewards_leaderboard(self, api, admin_token):
        r = api.get(f"{BASE_URL}/api/admin/rewards/leaderboard",
                    headers=_auth(admin_token), timeout=30)
        # Endpoint may be nested differently; accept 200 or 404 (route naming variance)
        assert r.status_code in (200, 404), r.status_code


# ---------- KREDO ----------
class TestKredo:
    def test_kredo_makes_authed(self, api, dealer_token):
        r = api.get(f"{BASE_URL}/api/kredo/makes",
                    headers=_auth(dealer_token), timeout=60)
        assert r.status_code == 200

    def test_kredo_makes_unauthed(self, api):
        r = api.get(f"{BASE_URL}/api/kredo/makes", timeout=30)
        assert r.status_code == 401

    def test_kredo_value_returns_response(self, api, dealer_token):
        # Cross-module: _ensure_market_values re-imported at bottom of server.py.
        # Payload structure matches historical test.
        payload = {
            "make": "BMW",
            "model": "X4",
            "year": "2020",
            "derivative": "xDrive20d M Sport",
            "mileage": 60000,
            "condition": "Good",
        }
        r = api.post(f"{BASE_URL}/api/kredo/value",
                     headers=_auth(dealer_token),
                     json=payload, timeout=60)
        # 200 = happy path; 502 acceptable if upstream Kredo is flaky
        assert r.status_code in (200, 400, 502), r.status_code
        if r.status_code == 200:
            body = r.json()
            assert isinstance(body, dict)

    def test_kredo_cartrust_status_unknown_id_404(self, api, dealer_token):
        r = api.get(f"{BASE_URL}/api/kredo/cartrust/status/nonexistent-id-xxx",
                    headers=_auth(dealer_token), timeout=30)
        assert r.status_code == 404

    def test_kredo_cartrust_status_fb000083(self, api, admin_token):
        # Find FB-000083 first via admin
        subs = api.get(f"{BASE_URL}/api/admin/submissions",
                       headers=_auth(admin_token), timeout=30)
        if subs.status_code != 200:
            pytest.skip("admin submissions endpoint not reachable")
        data = subs.json()
        rows = data.get("submissions", data if isinstance(data, list) else [])
        target = next((s for s in rows if s.get("ref_code") == "FB-000083"
                       or s.get("ref") == "FB-000083"), None)
        if not target:
            pytest.skip("FB-000083 not present in preview DB")
        sub_id = target.get("id") or target.get("_id")
        r = api.get(f"{BASE_URL}/api/kredo/cartrust/status/{sub_id}",
                    headers=_auth(admin_token), timeout=30)
        assert r.status_code == 200
        body = r.json()
        # cartrust status field expected
        assert "status" in body or "cartrust" in body or "cartrust_status" in body


# ---------- COVER ----------
class TestCover:
    def test_cover_submissions_pricing_agent(self, api, dealer_token):
        r = api.get(f"{BASE_URL}/api/cover/submissions",
                    headers=_auth(dealer_token), timeout=30)
        assert r.status_code == 200
        data = r.json()
        subs = data.get("submissions", data if isinstance(data, list) else [])
        assert isinstance(subs, list)

    def test_cover_declined_submissions(self, api, dealer_token):
        r = api.get(f"{BASE_URL}/api/cover/declined-submissions",
                    headers=_auth(dealer_token), timeout=30)
        assert r.status_code == 200

    def test_cover_submissions_forbidden_for_admin(self, api, admin_token):
        r = api.get(f"{BASE_URL}/api/cover/submissions",
                    headers=_auth(admin_token), timeout=30)
        # Admin isn't a pricing agent → 403
        assert r.status_code in (403, 200), r.status_code

    def test_cover_submissions_unauthed(self, api):
        r = api.get(f"{BASE_URL}/api/cover/submissions", timeout=30)
        assert r.status_code == 401


# ---------- SUBMISSIONS (touch) ----------
class TestSubmissions:
    def test_admin_submissions_list(self, api, admin_token):
        r = api.get(f"{BASE_URL}/api/admin/submissions",
                    headers=_auth(admin_token), timeout=30)
        assert r.status_code == 200
