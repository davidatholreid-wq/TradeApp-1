"""Backend tests for Silo/Bucket tabs + 14-day auto-archive feature."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"
DEALER_EMAIL = "minitest@example.com"
DEALER_PASSWORD = "Mini1234!"
HILUX_ARCHIVED_ID = "bf712655-d666-431a-bea8-0e77eb5b9e81"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "token" in data
    return data["token"]


@pytest.fixture(scope="module")
def dealer_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": DEALER_EMAIL, "password": DEALER_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, f"dealer login failed: {r.status_code} {r.text}"
    return r.json()["token"]


def _auth(tok):
    return {"Authorization": f"Bearer {tok}"}


# ---- Admin: /api/admin/submissions bucket filter + counts ----
class TestAdminSubmissionsBuckets:
    def test_default_all_returns_counts_and_bucket_field(self, admin_token):
        r = requests.get(f"{BASE_URL}/api/admin/submissions", headers=_auth(admin_token), timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "submissions" in data
        assert "counts" in data
        assert "archive_after_days" in data
        assert data["archive_after_days"] == 14
        counts = data["counts"]
        for k in ("incoming", "priced", "archived"):
            assert k in counts, f"missing count key: {k}"
            assert isinstance(counts[k], int) and counts[k] >= 0
        # Every submission must carry a bucket field with a valid value
        for s in data["submissions"]:
            assert s.get("bucket") in {"incoming", "priced", "archived"}, s.get("bucket")

    def test_bucket_incoming_filters(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/admin/submissions?bucket=incoming",
            headers=_auth(admin_token),
            timeout=15,
        )
        assert r.status_code == 200
        data = r.json()
        assert all(s["bucket"] == "incoming" for s in data["submissions"])
        # Counts are full-dataset (must equal counts from ?bucket=all)
        r2 = requests.get(f"{BASE_URL}/api/admin/submissions?bucket=all", headers=_auth(admin_token), timeout=15)
        assert r2.status_code == 200
        assert data["counts"] == r2.json()["counts"]

    def test_bucket_priced_filters(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/admin/submissions?bucket=priced",
            headers=_auth(admin_token),
            timeout=15,
        )
        assert r.status_code == 200
        data = r.json()
        assert all(s["bucket"] == "priced" for s in data["submissions"])

    def test_bucket_archived_filters(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/admin/submissions?bucket=archived",
            headers=_auth(admin_token),
            timeout=15,
        )
        assert r.status_code == 200
        data = r.json()
        assert all(s["bucket"] == "archived" for s in data["submissions"])
        # Hilux archived sub must be here
        ids = [s["id"] for s in data["submissions"]]
        assert HILUX_ARCHIVED_ID in ids, f"expected archived Hilux {HILUX_ARCHIVED_ID} in archived bucket; got {ids}"

    def test_bucket_all_returns_full_list(self, admin_token):
        r = requests.get(f"{BASE_URL}/api/admin/submissions?bucket=all", headers=_auth(admin_token), timeout=15)
        assert r.status_code == 200
        data = r.json()
        total = data["counts"]["incoming"] + data["counts"]["priced"] + data["counts"]["archived"]
        assert len(data["submissions"]) == total

    def test_counts_match_actual_buckets(self, admin_token):
        r = requests.get(f"{BASE_URL}/api/admin/submissions?bucket=all", headers=_auth(admin_token), timeout=15)
        assert r.status_code == 200
        data = r.json()
        actual = {"incoming": 0, "priced": 0, "archived": 0}
        for s in data["submissions"]:
            actual[s["bucket"]] += 1
        assert actual == data["counts"]


# ---- Dealer view filtering ----
class TestDealerSubmissionsFiltering:
    def test_dealer_my_excludes_archived(self, dealer_token):
        r = requests.get(f"{BASE_URL}/api/submissions/my", headers=_auth(dealer_token), timeout=15)
        assert r.status_code == 200
        data = r.json()
        for s in data["submissions"]:
            assert s.get("bucket") in {"incoming", "priced"}, f"dealer got archived: {s}"
        ids = [s["id"] for s in data["submissions"]]
        assert HILUX_ARCHIVED_ID not in ids, "archived Hilux must not appear in dealer /submissions/my"

    def test_dealer_direct_get_archived_returns_404(self, dealer_token):
        r = requests.get(
            f"{BASE_URL}/api/submissions/{HILUX_ARCHIVED_ID}",
            headers=_auth(dealer_token),
            timeout=15,
        )
        assert r.status_code == 404, f"dealer archived direct-fetch should 404; got {r.status_code} {r.text}"

    def test_admin_direct_get_archived_returns_200(self, admin_token):
        r = requests.get(
            f"{BASE_URL}/api/submissions/{HILUX_ARCHIVED_ID}",
            headers=_auth(admin_token),
            timeout=15,
        )
        assert r.status_code == 200, f"admin should see archived; got {r.status_code} {r.text}"
        data = r.json()
        assert data["submission"]["bucket"] == "archived"
        assert data["submission"]["id"] == HILUX_ARCHIVED_ID
