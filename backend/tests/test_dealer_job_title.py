"""
Test PATCH /api/admin/dealers/{dealer_id} job_title editing.

Verifies:
  - set job_title
  - clear via empty string -> null
  - omit (send null) leaves existing value intact
  - other fields not overwritten when only job_title updated
"""
import os
import pytest
import requests

BASE_URL = (os.environ.get("EXPO_BACKEND_URL") or os.environ.get("EXPO_PUBLIC_BACKEND_URL") or "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"
DEALER_EMAIL = "minitest@example.com"
DEALER_PASSWORD = "Mini1234!"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def dealer_id(admin_headers):
    # Find minitest dealer
    r = requests.get(f"{BASE_URL}/api/admin/dealers", headers=admin_headers)
    assert r.status_code == 200
    data = r.json()
    dealers = data if isinstance(data, list) else data.get("dealers", [])
    for d in dealers:
        if d.get("email") == DEALER_EMAIL:
            return d["id"]
    pytest.skip(f"Dealer {DEALER_EMAIL} not found")


def _patch(headers, dealer_id, body):
    return requests.patch(f"{BASE_URL}/api/admin/dealers/{dealer_id}", headers=headers, json=body)


def test_set_job_title(admin_headers, dealer_id):
    r = _patch(admin_headers, dealer_id, {"job_title": "Sales Manager"})
    assert r.status_code == 200, r.text
    dealer = r.json()["dealer"]
    assert dealer["dealer_info"]["job_title"] == "Sales Manager"


def test_get_persists_job_title(admin_headers, dealer_id):
    _patch(admin_headers, dealer_id, {"job_title": "Head of Trade"})
    r = requests.get(f"{BASE_URL}/api/admin/dealers/{dealer_id}", headers=admin_headers)
    assert r.status_code == 200
    body = r.json()
    dealer = body.get("dealer", body)
    assert dealer["dealer_info"]["job_title"] == "Head of Trade"


def test_clear_job_title_via_empty_string(admin_headers, dealer_id):
    # Ensure set first
    _patch(admin_headers, dealer_id, {"job_title": "Something"})
    r = _patch(admin_headers, dealer_id, {"job_title": ""})
    assert r.status_code == 200, r.text
    dealer = r.json()["dealer"]
    assert dealer["dealer_info"].get("job_title") in (None, "", False), (
        f"Expected cleared job_title, got {dealer['dealer_info'].get('job_title')!r}"
    )
    # Explicitly assert None (per requirement)
    assert dealer["dealer_info"].get("job_title") is None


def test_omitting_job_title_leaves_existing_intact(admin_headers, dealer_id):
    # First set a known job title
    _patch(admin_headers, dealer_id, {"job_title": "Preserved Title"})
    # Now patch OTHER fields without job_title in payload
    r = _patch(admin_headers, dealer_id, {"phone": "0821234567"})
    assert r.status_code == 200
    dealer = r.json()["dealer"]
    assert dealer["dealer_info"]["job_title"] == "Preserved Title", (
        f"job_title should be preserved when omitted, got {dealer['dealer_info'].get('job_title')!r}"
    )


def test_job_title_does_not_overwrite_other_fields(admin_headers, dealer_id):
    # Seed known values first
    seed = {
        "first_name": "Test",
        "last_name": "Dealer",
        "phone": "0821234567",
        "company_name": "Mini Test Motors",
        "company_address": "1 Test Ave",
        "job_title": "Original Title",
    }
    r = _patch(admin_headers, dealer_id, seed)
    assert r.status_code == 200
    # Now change ONLY job_title
    r2 = _patch(admin_headers, dealer_id, {"job_title": "New Title"})
    assert r2.status_code == 200
    dealer = r2.json()["dealer"]
    assert dealer["dealer_info"]["first_name"] == "Test"
    assert dealer["dealer_info"]["last_name"] == "Dealer"
    assert dealer["dealer_info"]["phone"] == "0821234567"
    assert dealer["company_info"]["company_name"] == "Mini Test Motors"
    assert dealer["company_info"]["company_address"] == "1 Test Ave"
    assert dealer["dealer_info"]["job_title"] == "New Title"


def test_final_cleanup_clear_job_title(admin_headers, dealer_id):
    r = _patch(admin_headers, dealer_id, {"job_title": ""})
    assert r.status_code == 200
    assert r.json()["dealer"]["dealer_info"].get("job_title") is None
