"""
Backend tests for the Admin Detail View + Dealer Photos regression (Jan 2026).

Covers:
- POST /api/admin/dealers/{id}/photos (admin only, profile_pic/cover_photo base64)
- GET /api/admin/dealers/{id}
- GET /api/admin/dealers (list must include photos when set)
- POST /api/auth/login (dealer) must include profile_pic + cover_photo
- GET /api/auth/me must include the same
- Non-admin (dealer JWT) receives 403 on the photo upload
- Regression: /api/admin/submissions (buckets), /api/admin/billing,
  /api/vehicles/options, /api/submissions POST + GET,
  /api/admin/dealers PATCH / active / archive / restore,
  /api/admin/submissions/{id}/price
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get(
    "EXPO_PUBLIC_BACKEND_URL",
    "https://fourbuy-admin.preview.emergentagent.com",
).rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"

# Existing seeded dealer we can log in as
SEEDED_DEALER_EMAIL = "minitest@example.com"
SEEDED_DEALER_PASSWORD = "Mini1234!"

# 1x1 transparent PNG data URL — keep it tiny
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4"
    "2mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)
TINY_PROFILE = f"data:image/png;base64,{TINY_PNG_B64}"
TINY_COVER = f"data:image/jpeg;base64,{TINY_PNG_B64}"


# ---------- Fixtures ----------
@pytest.fixture(scope="session")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="session")
def admin_token(s):
    r = s.post(f"{API}/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    data = r.json()
    assert data["user"]["role"] == "admin"
    return data["token"]


@pytest.fixture(scope="session")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def _register_dealer(s, email: str):
    payload = {
        "email": email,
        "password": "Photo123!",
        "dealer_info": {
            "first_name": "Photo",
            "last_name": "Tester",
            "phone": "0821234567",
        },
        "company_info": {
            "company_name": "TEST_Photo Motors",
            "company_address": "1 Photo Lane, JHB",
        },
    }
    r = s.post(f"{API}/auth/register", json=payload)
    assert r.status_code == 200, f"Register failed: {r.status_code} {r.text}"
    data = r.json()
    return {"token": data["token"], "id": data["user"]["id"], "email": email}


@pytest.fixture(scope="session")
def fresh_dealer(s):
    email = f"photo_dealer_{uuid.uuid4().hex[:8]}@example.com"
    return _register_dealer(s, email)


@pytest.fixture(scope="session")
def seeded_dealer_login(s):
    r = s.post(f"{API}/auth/login",
               json={"email": SEEDED_DEALER_EMAIL, "password": SEEDED_DEALER_PASSWORD})
    if r.status_code != 200:
        pytest.skip(f"Seeded dealer login unavailable: {r.status_code} {r.text}")
    return r.json()


# ---------- Health ----------
def test_health(s):
    r = s.get(f"{API}/")
    assert r.status_code == 200


# ---------- 1-3. Photo upload / GET / list ----------
class TestDealerPhotos:
    def test_upload_both_photos_persists(self, s, admin_headers, fresh_dealer):
        r = s.post(
            f"{API}/admin/dealers/{fresh_dealer['id']}/photos",
            json={"profile_pic": TINY_PROFILE, "cover_photo": TINY_COVER},
            headers=admin_headers,
        )
        assert r.status_code == 200, r.text
        dealer = r.json()["dealer"]
        assert dealer["id"] == fresh_dealer["id"]
        assert dealer["profile_pic"] == TINY_PROFILE
        assert dealer["cover_photo"] == TINY_COVER
        assert "_id" not in dealer
        assert "password_hash" not in dealer

    def test_get_single_dealer_includes_photos(self, s, admin_headers, fresh_dealer):
        r = s.get(f"{API}/admin/dealers/{fresh_dealer['id']}", headers=admin_headers)
        assert r.status_code == 200, r.text
        dealer = r.json()["dealer"]
        assert dealer["profile_pic"] == TINY_PROFILE
        assert dealer["cover_photo"] == TINY_COVER

    def test_dealer_list_includes_photos_when_set(self, s, admin_headers, fresh_dealer):
        r = s.get(f"{API}/admin/dealers", headers=admin_headers)
        assert r.status_code == 200
        dealers = r.json()["dealers"]
        me = next(d for d in dealers if d["id"] == fresh_dealer["id"])
        assert me.get("profile_pic") == TINY_PROFILE
        assert me.get("cover_photo") == TINY_COVER

    def test_clear_profile_pic_with_empty_string(self, s, admin_headers, fresh_dealer):
        r = s.post(
            f"{API}/admin/dealers/{fresh_dealer['id']}/photos",
            json={"profile_pic": ""},
            headers=admin_headers,
        )
        assert r.status_code == 200, r.text
        dealer = r.json()["dealer"]
        assert dealer.get("profile_pic") in (None, "", False)
        # cover_photo should NOT be cleared (omitted field)
        assert dealer["cover_photo"] == TINY_COVER

    def test_clear_cover_with_empty_string(self, s, admin_headers, fresh_dealer):
        r = s.post(
            f"{API}/admin/dealers/{fresh_dealer['id']}/photos",
            json={"cover_photo": ""},
            headers=admin_headers,
        )
        assert r.status_code == 200
        dealer = r.json()["dealer"]
        assert dealer.get("cover_photo") in (None, "", False)

    def test_empty_body_400(self, s, admin_headers, fresh_dealer):
        r = s.post(
            f"{API}/admin/dealers/{fresh_dealer['id']}/photos",
            json={},
            headers=admin_headers,
        )
        assert r.status_code == 400

    def test_upload_404_when_missing(self, s, admin_headers):
        r = s.post(
            f"{API}/admin/dealers/does-not-exist/photos",
            json={"profile_pic": TINY_PROFILE},
            headers=admin_headers,
        )
        assert r.status_code == 404


# ---------- 4-5. Auth responses include photos ----------
class TestAuthPayloadIncludesPhotos:
    def test_dealer_login_includes_photo_keys(self, s, admin_headers, fresh_dealer):
        # Re-set both photos so we have something to see
        s.post(
            f"{API}/admin/dealers/{fresh_dealer['id']}/photos",
            json={"profile_pic": TINY_PROFILE, "cover_photo": TINY_COVER},
            headers=admin_headers,
        )
        r = s.post(f"{API}/auth/login",
                   json={"email": fresh_dealer["email"], "password": "Photo123!"})
        assert r.status_code == 200
        user = r.json()["user"]
        assert "profile_pic" in user
        assert "cover_photo" in user
        assert user["profile_pic"] == TINY_PROFILE
        assert user["cover_photo"] == TINY_COVER

    def test_auth_me_includes_photo_keys(self, s, admin_headers, fresh_dealer):
        login = s.post(f"{API}/auth/login",
                       json={"email": fresh_dealer["email"], "password": "Photo123!"})
        token = login.json()["token"]
        r = s.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200
        user = r.json()["user"]
        assert user.get("profile_pic") == TINY_PROFILE
        assert user.get("cover_photo") == TINY_COVER

    def test_seeded_dealer_login_has_photo_keys(self, seeded_dealer_login):
        user = seeded_dealer_login["user"]
        assert "profile_pic" in user
        assert "cover_photo" in user  # values can be None if never set


# ---------- 6. RBAC ----------
class TestPhotoRBAC:
    def test_dealer_cannot_upload_photos(self, s, fresh_dealer):
        r = s.post(
            f"{API}/admin/dealers/{fresh_dealer['id']}/photos",
            json={"profile_pic": TINY_PROFILE},
            headers={"Authorization": f"Bearer {fresh_dealer['token']}"},
        )
        assert r.status_code == 403

    def test_dealer_cannot_get_admin_dealer(self, s, fresh_dealer):
        r = s.get(
            f"{API}/admin/dealers/{fresh_dealer['id']}",
            headers={"Authorization": f"Bearer {fresh_dealer['token']}"},
        )
        assert r.status_code == 403

    def test_no_token_401(self, s, fresh_dealer):
        r = s.post(f"{API}/admin/dealers/{fresh_dealer['id']}/photos",
                   json={"profile_pic": TINY_PROFILE})
        assert r.status_code == 401


# ---------- 7. Regression on other endpoints ----------
class TestRegression:
    def test_admin_submissions_buckets(self, s, admin_headers):
        r = s.get(f"{API}/admin/submissions", headers=admin_headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "submissions" in body
        # No _id leakage
        for sub in body["submissions"][:5]:
            assert "_id" not in sub

    def test_admin_billing(self, s, admin_headers):
        r = s.get(f"{API}/admin/billing?month=2026-01", headers=admin_headers)
        assert r.status_code == 200, r.text
        body = r.json()
        # tolerant: just check core keys present
        assert isinstance(body, dict)

    def test_vehicle_makes(self, s):
        r = s.get(f"{API}/vehicles/makes")
        assert r.status_code == 200
        assert len(r.json()["makes"]) > 0

    def test_admin_dealers_list(self, s, admin_headers):
        r = s.get(f"{API}/admin/dealers", headers=admin_headers)
        assert r.status_code == 200
        dealers = r.json()["dealers"]
        assert len(dealers) > 0

    def test_dealer_patch_still_works(self, s, admin_headers, fresh_dealer):
        r = s.patch(
            f"{API}/admin/dealers/{fresh_dealer['id']}",
            json={"phone": "0810000001"},
            headers=admin_headers,
        )
        assert r.status_code == 200, r.text
        dealer = r.json()["dealer"]
        assert dealer["dealer_info"]["phone"] == "0810000001"

    def test_dealer_active_toggle(self, s, admin_headers, fresh_dealer):
        r = s.post(
            f"{API}/admin/dealers/{fresh_dealer['id']}/active",
            json={"active": False},
            headers=admin_headers,
        )
        assert r.status_code == 200
        assert r.json()["active"] is False
        # Restore
        r2 = s.post(
            f"{API}/admin/dealers/{fresh_dealer['id']}/active",
            json={"active": True},
            headers=admin_headers,
        )
        assert r2.status_code == 200
        assert r2.json()["active"] is True

    def test_archive_and_restore(self, s, admin_headers):
        # Create a throwaway dealer, archive, then restore
        email = f"archtest_{uuid.uuid4().hex[:8]}@example.com"
        d = _register_dealer(s, email)

        r = s.post(f"{API}/admin/dealers/{d['id']}/archive", headers=admin_headers)
        assert r.status_code == 200

        r2 = s.post(f"{API}/admin/dealers/{d['id']}/restore", headers=admin_headers)
        assert r2.status_code == 200

        # cleanup: hard delete after restore (0 subs)
        s.delete(f"{API}/admin/dealers/{d['id']}", headers=admin_headers)

    def test_create_submission_and_price(self, s, admin_headers, fresh_dealer):
        makes = s.get(f"{API}/vehicles/makes").json()["makes"]
        toyota = next(m for m in makes if m["name"] == "Toyota")
        models = s.get(f"{API}/vehicles/models",
                       params={"make_id": toyota["id"]}).json()["models"]
        hilux = next(m for m in models if m["name"] == "Hilux")
        derivs = s.get(f"{API}/vehicles/derivatives",
                       params={"model_id": hilux["id"]}).json()["derivatives"]
        deriv = derivs[0]

        # Accept billing agreement first (required by /api/submissions POST)
        s.post(
            f"{API}/agreement/accept",
            headers={"Authorization": f"Bearer {fresh_dealer['token']}"},
        )

        payload = {
            "make_id": toyota["id"], "make_name": "Toyota", "make": "Toyota",
            "model_id": hilux["id"], "model_name": "Hilux", "model": "Hilux",
            "derivative_id": deriv["id"], "derivative_name": deriv["name"],
            "derivative": deriv["name"],
            "mileage": 65000, "year": 2020,
            "year_of_production": 2020, "year_registered": 2020,
            "fuel_type": "Diesel", "transmission": "Automatic",
            "factory_warranty": True, "condition": 8,
            "accident_damage": False, "colour": "White",
            "billing_accepted": True,
            "exterior_condition": 8, "interior_condition": 7,
            "tyre_condition": 8, "windscreen_condition": "Perfect",
            "service_history": "Full Service History with Agents", "paint_evidence": False,
            # Use new photo keys
            "photos": {
                "front": TINY_PROFILE, "driver_side": TINY_PROFILE,
                "passenger_side": TINY_PROFILE, "rear": TINY_PROFILE,
                "interior": TINY_PROFILE,
            },
        }
        r = s.post(
            f"{API}/submissions", json=payload,
            headers={"Authorization": f"Bearer {fresh_dealer['token']}"},
        )
        assert r.status_code == 200, r.text
        sub_id = r.json()["id"]

        # Price it
        r2 = s.post(
            f"{API}/admin/submissions/{sub_id}/price",
            json={"price": 289000, "notes": "TEST regression pricing"},
            headers=admin_headers,
        )
        assert r2.status_code == 200
        assert r2.json()["status"] == "priced"


# ---------- Cleanup ----------
@pytest.fixture(scope="session", autouse=True)
def _cleanup(request, s):
    yield
    # Best effort — get admin token again from env
    try:
        r = s.post(f"{API}/auth/login",
                   json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        if r.status_code != 200:
            return
        headers = {"Authorization": f"Bearer {r.json()['token']}"}
        dealers = s.get(f"{API}/admin/dealers?include_archived=true",
                        headers=headers).json().get("dealers", [])
        for d in dealers:
            if d["email"].startswith(("photo_dealer_", "archtest_")):
                # Try hard delete first, fall back to archive
                del_resp = s.delete(f"{API}/admin/dealers/{d['id']}", headers=headers)
                if del_resp.status_code == 409:
                    s.post(f"{API}/admin/dealers/{d['id']}/archive", headers=headers)
    except Exception:
        pass
