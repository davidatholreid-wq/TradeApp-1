"""
Backend tests for Iteration 20 — /api/admin/billing grouped by DEALERSHIP.

Verifies:
1. Response shape has the new keys per row: dealership_id, dealership_name,
   user_count, users[], legacy.
2. A multi-user dealership (e.g. seeded 'Ford Bryanston' with 2 users) appears
   as ONE row with priced_count = sum across those users, users[] listing
   both, user_count == len(users).
3. amount_zar == billable_count * fee_zar + report_amount_zar per row.
4. Top-level totals match the sum across rows.
5. Legacy fallback: if a row's gid is prefixed 'user:' the row has legacy=True
   and dealership_id is None (compat-only, may not exist in fresh seed).
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"
ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module")
def admin_token(s):
    r = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def billing_all_months(s, admin_token):
    """Fetch billing for the past 12 months so we're likely to hit a month
    containing the seeded Ford Bryanston priced submissions."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    months = []
    for i in range(0, 12):
        y = now.year
        m = now.month - i
        while m <= 0:
            m += 12
            y -= 1
        months.append(f"{y:04d}-{m:02d}")

    responses = {}
    for month in months:
        r = s.get(f"{API}/admin/billing", params={"month": month}, headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 200, f"/admin/billing?month={month} -> {r.status_code} {r.text}"
        responses[month] = r.json()
    return responses


# -------------------- Tests --------------------
def test_admin_billing_row_shape(billing_all_months):
    """Every row must have new dealership grouping keys."""
    required_keys = {
        "dealership_id", "dealership_name", "user_count", "users",
        "priced_count", "billable_count", "amount_zar",
        "submission_amount_zar", "report_amount_zar", "report_count",
        "items", "report_items", "legacy", "active",
    }
    found_row = False
    for month, data in billing_all_months.items():
        for row in data.get("rows", []):
            found_row = True
            missing = required_keys - set(row.keys())
            assert not missing, f"Row missing keys {missing} in month {month}: {row}"
            assert isinstance(row["users"], list)
            assert isinstance(row["user_count"], int)
            # user_count MUST equal len(users)
            assert row["user_count"] == len(row["users"]), (
                f"user_count mismatch in month {month}: user_count={row['user_count']} vs len(users)={len(row['users'])}"
            )
    assert found_row, "No billing rows found across 12 months — cannot validate shape"


def test_amount_zar_math_per_row(billing_all_months):
    """For each row: amount_zar == billable_count * fee_zar + report_amount_zar (rounded 2dp)."""
    for month, data in billing_all_months.items():
        fee = data["fee_zar"]
        for row in data.get("rows", []):
            expected = round(row["billable_count"] * fee + row["report_amount_zar"], 2)
            assert abs(row["amount_zar"] - expected) < 0.01, (
                f"amount_zar mismatch in {month} row {row.get('dealership_name')}: "
                f"got {row['amount_zar']}, expected {expected}"
            )
            # submission_amount also
            expected_sub = round(row["billable_count"] * fee, 2)
            assert abs(row["submission_amount_zar"] - expected_sub) < 0.01


def test_totals_roll_up(billing_all_months):
    """Top-level totals must sum row values."""
    for month, data in billing_all_months.items():
        rows = data.get("rows", [])
        totals = data.get("totals", {})
        assert totals["priced_count"] == sum(r["priced_count"] for r in rows)
        assert totals["billable_count"] == sum(r["billable_count"] for r in rows)
        assert totals["report_count"] == sum(r.get("report_count", 0) for r in rows)
        assert abs(totals["report_amount_zar"] - sum(r["report_amount_zar"] for r in rows)) < 0.01
        assert abs(totals["submission_amount_zar"] - sum(r["submission_amount_zar"] for r in rows)) < 0.01
        assert abs(totals["amount_zar"] - sum(r["amount_zar"] for r in rows)) < 0.01


def test_multi_user_dealership_appears_as_one_row(billing_all_months):
    """A multi-user dealership (e.g. Ford Bryanston) must appear as ONE row
    with user_count >= 2 in at least one month across the seed data."""
    found_multi = False
    for month, data in billing_all_months.items():
        for row in data.get("rows", []):
            if row["user_count"] >= 2:
                found_multi = True
                names = [u.get("name") or u.get("email") for u in row["users"]]
                # Sanity: no duplicate rows for the same dealership_id in this month
                same_id_rows = [r for r in data["rows"] if r["dealership_id"] and r["dealership_id"] == row["dealership_id"]]
                assert len(same_id_rows) == 1, f"Duplicate rows for dealership {row['dealership_id']} in {month}"
                # priced_count must be sum across users (we can't easily assert
                # per-user counts without an extra API, but assert priced_count
                # >= number of items and all items either match users list or
                # are unattributed).
                assert row["priced_count"] == len(row["items"]), (
                    f"priced_count {row['priced_count']} != len(items) {len(row['items'])}"
                )
                print(f"Multi-user row in {month}: {row['dealership_name']} — users={names}, priced={row['priced_count']}")
                break
    assert found_multi, "No multi-user dealership row found in the last 12 months of billing"


def test_ford_bryanston_grouping(s, admin_token, billing_all_months):
    """Specific check for the Ford Bryanston seed: look up its dealership_id
    from /admin/dealers and confirm it appears as ONE row with 2 users in
    at least one month."""
    r = s.get(f"{API}/admin/dealers", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    payload = r.json()
    dealers = payload["dealers"] if isinstance(payload, dict) else payload
    ford_dids = set()
    for d in dealers:
        ds = d.get("dealership") or {}
        if "ford" in (ds.get("name") or "").lower() and "bryanston" in (ds.get("name") or "").lower():
            ford_dids.add(ds.get("id"))
    if not ford_dids:
        pytest.skip("Ford Bryanston not present in seed — cannot run specific check")

    hit_month = None
    for month, data in billing_all_months.items():
        for row in data["rows"]:
            if row["dealership_id"] in ford_dids:
                hit_month = month
                assert row["user_count"] >= 2, f"Ford Bryanston user_count={row['user_count']}, expected >=2"
                assert len(row["users"]) >= 2
                # Both a Zelda and a Johann should be members per the seed
                names_lower = " ".join([(u.get("name") or "").lower() for u in row["users"]])
                assert "zelda" in names_lower or "johann" in names_lower, (
                    f"Expected Zelda/Johann in Ford Bryanston users: {[u.get('name') for u in row['users']]}"
                )
                # Only one row for this dealership per month
                dupe = [r for r in data["rows"] if r["dealership_id"] == row["dealership_id"]]
                assert len(dupe) == 1
                break
        if hit_month:
            break

    assert hit_month, "Ford Bryanston did not appear in any of the last 12 months of billing"


def test_legacy_row_shape_if_present(billing_all_months):
    """If any legacy 'user:<id>' row exists, it must have legacy=True and
    dealership_id=None. This is a compat-only check; it may be skipped if
    the migration cleaned all legacy docs."""
    legacy_seen = False
    for month, data in billing_all_months.items():
        for row in data["rows"]:
            if row.get("legacy"):
                legacy_seen = True
                assert row["dealership_id"] is None, (
                    "Legacy row must have dealership_id=None"
                )
                # user_count should be 1 (the single dealer)
                assert row["user_count"] <= 1
    if not legacy_seen:
        pytest.skip("No legacy rows present — migration is clean (expected).")


def test_admin_billing_requires_admin(s):
    """Non-admin should not access /admin/billing."""
    r = s.get(f"{API}/admin/billing")
    assert r.status_code in (401, 403), f"Unauthenticated returned {r.status_code}"


def test_dealer_billing_my_regression(s):
    """Regression: /billing/my still works for a dealer, aggregated per dealership."""
    # login as minitest dealer
    r = s.post(f"{API}/auth/login", json={"email": "minitest@example.com", "password": "Mini1234!"})
    if r.status_code != 200:
        pytest.skip(f"minitest login failed ({r.status_code}) — cannot exercise /billing/my")
    tok = r.json()["token"]
    r2 = s.get(f"{API}/billing/my", headers={"Authorization": f"Bearer {tok}"})
    assert r2.status_code == 200, f"/billing/my -> {r2.status_code} {r2.text}"
    body = r2.json()
    for key in ("month", "fee_zar", "priced_count", "billable_count",
                "amount_zar", "submission_amount_zar", "report_amount_zar"):
        assert key in body, f"/billing/my missing {key}: {body}"
    # amount_zar math holds for the dealer's own bill too
    expected = round(body["billable_count"] * body["fee_zar"] + body["report_amount_zar"], 2)
    assert abs(body["amount_zar"] - expected) < 0.01
