"""
Backend tests for Fourbuy Archive-instead-of-Hard-Delete feature (Jan 2026).
Covers:
- DELETE /api/admin/dealers/{id} → 200 hard_delete when 0 submissions
- DELETE with submissions → 409 with exact message + preserves data
- POST /api/admin/dealers/{id}/archive → soft-delete, hides dealer, preserves subs
- Archived dealer login → 403 with 'archived' message (distinct from suspend)
- GET /api/admin/dealers respects include_archived query param
- GET /api/admin/billing rows expose archived boolean + archived_at
- POST /api/admin/dealers/{id}/restore clears archived_at
- Restore on non-archived dealer → 400
- Suspend still works independently (no archived_at)
"""
import os
import uuid
import pytest
import requests
from datetime import datetime, timezone

BASE_URL = "https://fourbuy-admin.preview.emergentagent.com"
API = f"{BASE_URL}/api"
ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"
MINITEST_EMAIL = "minitest@example.com"
MINITEST_PASSWORD = "Mini1234!"

TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module")
def admin_h(s):
    r = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


# ---------- Helper: create a zero-submission dealer ----------
@pytest.fixture(scope="module")
def zero_sub_dealer(s):
    email = f"TEST_archive_{uuid.uuid4().hex[:8]}@example.com"
    payload = {
        "email": email,
        "password": "TestArchive123!",
        "dealer_info": {"first_name": "Zero", "last_name": "Sub", "phone": "0820000000"},
        "company_info": {"company_name": "TEST_ZeroSub", "company_address": "1 Nowhere Rd"},
    }
    r = s.post(f"{API}/auth/register", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()
    return {"id": data["user"]["id"], "email": email, "password": "TestArchive123!"}


# ---------- Helper: dealer with submissions to archive ----------
@pytest.fixture(scope="module")
def minitest_dealer(s, admin_h):
    """Look up minitest@example.com in the dealer list, ensure they have ≥1 submissions."""
    # Make sure minitest is NOT archived at test start (previous run may have left them)
    r = s.get(f"{API}/admin/dealers?include_archived=true", headers=admin_h)
    assert r.status_code == 200
    dealer = next((d for d in r.json()["dealers"] if d["email"] == MINITEST_EMAIL), None)
    assert dealer, "minitest@example.com must exist in the DB"
    if dealer.get("archived_at"):
        # restore first so we start from a clean state
        rr = s.post(f"{API}/admin/dealers/{dealer['id']}/restore", headers=admin_h)
        assert rr.status_code == 200
    # Also make sure active=True
    s.post(f"{API}/admin/dealers/{dealer['id']}/active", json={"active": True}, headers=admin_h)
    # Refetch to get billable_count/sub count
    r2 = s.get(f"{API}/admin/dealers", headers=admin_h)
    d2 = next((d for d in r2.json()["dealers"] if d["email"] == MINITEST_EMAIL), None)
    assert d2, "minitest must be visible in default list after restore"
    return d2


# ---------- 1. Zero-sub hard delete still works ----------
def test_zero_sub_hard_delete(s, admin_h, zero_sub_dealer):
    r = s.delete(f"{API}/admin/dealers/{zero_sub_dealer['id']}", headers=admin_h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "deleted"
    assert body["hard_delete"] is True
    # Neither default nor include_archived list contains them
    r2 = s.get(f"{API}/admin/dealers", headers=admin_h)
    assert not any(d["id"] == zero_sub_dealer["id"] for d in r2.json()["dealers"])
    r3 = s.get(f"{API}/admin/dealers?include_archived=true", headers=admin_h)
    assert not any(d["id"] == zero_sub_dealer["id"] for d in r3.json()["dealers"])


# ---------- 2. Delete-with-submissions returns 409 ----------
def test_delete_with_subs_blocks_409(s, admin_h, minitest_dealer):
    sub_count_before = 0
    r_subs = s.get(f"{API}/admin/submissions?bucket=all", headers=admin_h)
    assert r_subs.status_code == 200
    all_before = r_subs.json()["submissions"]
    sub_count_before = sum(1 for x in all_before if x["dealer_id"] == minitest_dealer["id"])
    assert sub_count_before >= 1, "minitest must have at least 1 submission for this test"

    r = s.delete(f"{API}/admin/dealers/{minitest_dealer['id']}", headers=admin_h)
    assert r.status_code == 409, f"Expected 409 got {r.status_code}: {r.text}"
    detail = r.json().get("detail", "")
    expected_msg = f"Dealer has {sub_count_before} submission(s). Archive them instead to preserve billing history."
    assert detail == expected_msg, f"Expected exact string; got: {detail!r}"

    # Dealer still in the default list
    r2 = s.get(f"{API}/admin/dealers", headers=admin_h)
    assert any(d["id"] == minitest_dealer["id"] for d in r2.json()["dealers"])

    # Submissions still in the DB
    r3 = s.get(f"{API}/admin/submissions?bucket=all", headers=admin_h)
    all_after = r3.json()["submissions"]
    assert len(all_after) == len(all_before), "no submissions should have been deleted"


# ---------- 3. Archive → hidden by default, visible when include_archived ----------
def test_archive_dealer(s, admin_h, minitest_dealer):
    # count total submissions before
    r_pre = s.get(f"{API}/admin/submissions?bucket=all", headers=admin_h)
    total_before = len(r_pre.json()["submissions"])

    r = s.post(f"{API}/admin/dealers/{minitest_dealer['id']}/archive", headers=admin_h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "archived"
    assert body["archived_at"]
    assert isinstance(body["submissions_preserved"], int)
    assert body["submissions_preserved"] >= 1

    # default list HIDES this dealer
    r2 = s.get(f"{API}/admin/dealers", headers=admin_h)
    assert not any(d["id"] == minitest_dealer["id"] for d in r2.json()["dealers"])

    # include_archived list shows them with archived_at != null
    r3 = s.get(f"{API}/admin/dealers?include_archived=true", headers=admin_h)
    row = next((d for d in r3.json()["dealers"] if d["id"] == minitest_dealer["id"]), None)
    assert row is not None
    assert row.get("archived_at"), "archived_at should be a non-null iso timestamp"
    assert row.get("active") is False

    # Submission count unchanged
    r4 = s.get(f"{API}/admin/submissions?bucket=all", headers=admin_h)
    total_after = len(r4.json()["submissions"])
    assert total_after == total_before, "archiving must not delete any submissions"


def test_archived_login_403_with_archived_msg(s, minitest_dealer):
    r = s.post(f"{API}/auth/login", json={"email": MINITEST_EMAIL, "password": MINITEST_PASSWORD})
    assert r.status_code == 403, r.text
    detail = r.json().get("detail", "").lower()
    assert "archived" in detail, f"Expected 'archived' in message, got: {detail!r}"
    # Distinct wording from suspension
    assert "suspend" not in detail, "archived message should NOT mention suspend"


def test_billing_row_archived_flag(s, admin_h, minitest_dealer):
    today = datetime.now(timezone.utc)
    month = f"{today.year:04d}-{today.month:02d}"
    r = s.get(f"{API}/admin/billing", params={"month": month}, headers=admin_h)
    assert r.status_code == 200
    body = r.json()
    for row in body["rows"]:
        assert "archived" in row and isinstance(row["archived"], bool)
        assert "archived_at" in row
    # The archived dealer, if they had priced submissions this month, must show archived=true
    my_row = next((row for row in body["rows"] if row["dealer_id"] == minitest_dealer["id"]), None)
    if my_row:
        assert my_row["archived"] is True
        assert my_row["archived_at"]
        # historical amount not zero'd (>= 0 sanity — no forced wipe)
        assert my_row["amount_zar"] >= 0


# ---------- 4. Restore ----------
def test_restore_dealer(s, admin_h, minitest_dealer):
    r = s.post(f"{API}/admin/dealers/{minitest_dealer['id']}/restore", headers=admin_h)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "restored"

    # Default list contains dealer again, archived_at is null, active is True
    r2 = s.get(f"{API}/admin/dealers", headers=admin_h)
    row = next((d for d in r2.json()["dealers"] if d["id"] == minitest_dealer["id"]), None)
    assert row is not None
    assert row.get("archived_at") in (None, "")
    assert row.get("active") is True

    # Login works again
    r3 = s.post(f"{API}/auth/login", json={"email": MINITEST_EMAIL, "password": MINITEST_PASSWORD})
    assert r3.status_code == 200, r3.text


def test_restore_non_archived_400(s, admin_h, minitest_dealer):
    # minitest is now restored (active + not archived) — restoring again must 400
    r = s.post(f"{API}/admin/dealers/{minitest_dealer['id']}/restore", headers=admin_h)
    assert r.status_code == 400, r.text


# ---------- 5. Suspend still independent from archive ----------
def test_suspend_still_works_independently(s, admin_h, minitest_dealer):
    # Suspend
    r = s.post(f"{API}/admin/dealers/{minitest_dealer['id']}/active",
               json={"active": False}, headers=admin_h)
    assert r.status_code == 200

    # Appears in default list (not hidden)
    r2 = s.get(f"{API}/admin/dealers", headers=admin_h)
    row = next((d for d in r2.json()["dealers"] if d["id"] == minitest_dealer["id"]), None)
    assert row is not None, "Suspended (not archived) dealer must remain in the default list"
    assert row.get("archived_at") in (None, "")
    assert row.get("active") is False

    # Login returns 403 with SUSPEND-flavoured message (not archived wording)
    r3 = s.post(f"{API}/auth/login", json={"email": MINITEST_EMAIL, "password": MINITEST_PASSWORD})
    assert r3.status_code == 403
    detail = r3.json().get("detail", "").lower()
    assert "suspend" in detail or "contact fourbuy" in detail
    assert "archived" not in detail, "Suspend message must not say 'archived'"

    # Reactivate so subsequent iterations do not hit login failures
    r4 = s.post(f"{API}/admin/dealers/{minitest_dealer['id']}/active",
                json={"active": True}, headers=admin_h)
    assert r4.status_code == 200


# ---------- 6. Cleanup: make absolutely sure minitest is left active/unarchived ----------
def test_zz_cleanup_leaves_minitest_usable(s, admin_h, minitest_dealer):
    # Make sure not archived
    r = s.get(f"{API}/admin/dealers?include_archived=true", headers=admin_h)
    row = next((d for d in r.json()["dealers"] if d["id"] == minitest_dealer["id"]), None)
    assert row is not None
    if row.get("archived_at"):
        s.post(f"{API}/admin/dealers/{minitest_dealer['id']}/restore", headers=admin_h)
    s.post(f"{API}/admin/dealers/{minitest_dealer['id']}/active",
           json={"active": True}, headers=admin_h)
    r2 = s.post(f"{API}/auth/login", json={"email": MINITEST_EMAIL, "password": MINITEST_PASSWORD})
    assert r2.status_code == 200, f"minitest login must work at end of run: {r2.text}"
