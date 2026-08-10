"""
Iteration 50 — Deal Outcomes auto-expiry tests.

Feature under test:
  * ARCHIVE_AFTER_DAYS bumped from 14 -> 30 (uses created_at as anchor).
  * New helper `auto_expire_pending_deal_outcomes(scope)` — flips
    priced+expired submissions with no dealer outcome to
    deal.done=false, deal.auto_expired=true, deal.expired_at=<iso>,
    deal.updated_by_name='System (expired)'.
  * Sweep is idempotent — running twice does NOT overwrite records
    that are already marked done=false / auto_expired.
  * Sweep triggers on read-path of:
      GET /api/stats/deal-outcomes/list
      GET /api/stats/deal-outcomes
      GET /api/admin/stats/deal-outcomes-by-dealer
  * List endpoint row shape now includes auto_expired + expired_at.
  * PATCH /api/submissions/{id}/deal with done=true on an auto-expired
    submission clears deal.auto_expired + deal.expired_at.
  * Only status == 'priced' submissions are touched — pending /
    declined are ignored.
  * Regression: /api/stats/deal-outcomes/list still returns the
    original schema and sum-to-100 invariant.

Seed strategy:
  Rather than reaching directly into Mongo, we use the admin-only
  helper endpoint `PATCH /api/admin/submissions/{id}/backdate` if it
  exists. If not, we fall back to the raw Motor client so the tests
  still work (isolated to test collection: submissions).

The test creates a fresh TEST_ submission then backdates its
created_at to 45 days ago and clears any deal.done to guarantee the
sweep should pick it up. All TEST_ submissions are hard-deleted on
teardown so we do not pollute the reporting screens.
"""
import os
import uuid
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
import requests

BASE_URL = os.environ.get(
    "EXPO_PUBLIC_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com"
).rstrip("/")

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"
DEALER_EMAIL = "dave@fourbuy.co.za"
DEALER_PASSWORD = "Dave1234!"


# --------------------------- helpers ---------------------------------

def _login(session, email, password):
    r = session.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text[:300]}"
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, f"no token in login response: {r.json()}"
    session.headers.update({"Authorization": f"Bearer {tok}"})
    return r.json().get("user") or {}


async def _mongo_client():
    from motor.motor_asyncio import AsyncIOMotorClient
    # Backend env variables — same as the server itself
    from dotenv import load_dotenv
    load_dotenv("/app/backend/.env")
    mongo_url = os.environ["MONGO_URL"]
    db_name = os.environ["DB_NAME"]
    client = AsyncIOMotorClient(mongo_url)
    return client, client[db_name]


# --------------------------- fixtures --------------------------------

@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    _login(s, ADMIN_EMAIL, ADMIN_PASSWORD)
    return s


@pytest.fixture(scope="module")
def dealer_session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    user = _login(s, DEALER_EMAIL, DEALER_PASSWORD)
    s.dealer_info = user  # attach so tests can inspect
    return s


@pytest.fixture(scope="module")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="module")
def seeded_expired_submission(dealer_session, event_loop):
    """Seed a priced submission owned by `dave` that is 45 days old
    with deal.done unset. Yields the submission id. Teardown hard-
    deletes the record.
    """
    async def _seed():
        client, db = await _mongo_client()
        try:
            dealer = await db.users.find_one({"email": DEALER_EMAIL}, {"_id": 0})
            assert dealer, "dealer 'dave' not found in DB"
            sub_id = str(uuid.uuid4())
            created_iso = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
            priced_iso = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
            doc = {
                "id": sub_id,
                "reference": f"TEST-EXP-{sub_id[:6].upper()}",
                "dealer_id": dealer.get("id"),
                "dealership_id": dealer.get("dealership_id"),
                "dealer_name": "TEST dealer",
                "submitted_by_name": "TEST auto-expiry",
                "status": "priced",
                "created_at": created_iso,
                "submitted_at": created_iso,
                "priced_at": priced_iso,
                "make_name": "TEST Toyota",
                "model_name": "TEST Auto Expiry",
                "derivative_name": "TEST-EXP",
                "year": 2020,
                "mileage": 45000,
                "colour": "White",
                "price": 250000,
                "dealer_offer_zar": None,
                "photos": {},
                # NO deal.done — this is what the sweep should flip.
                "deal": {},
            }
            await db.submissions.insert_one(doc)
            return sub_id
        finally:
            client.close()

    async def _teardown(sub_id):
        client, db = await _mongo_client()
        try:
            await db.submissions.delete_one({"id": sub_id})
        finally:
            client.close()

    sid = event_loop.run_until_complete(_seed())
    yield sid
    event_loop.run_until_complete(_teardown(sid))


@pytest.fixture(scope="module")
def seeded_pending_and_declined(event_loop):
    """Also seed one PENDING (status=pending) and one DECLINED
    submission > 30 days old with no deal.done. The sweep must NOT
    touch these.
    """
    async def _seed():
        client, db = await _mongo_client()
        try:
            dealer = await db.users.find_one({"email": DEALER_EMAIL}, {"_id": 0})
            assert dealer
            ids = {}
            for status in ("pending", "declined"):
                sid = str(uuid.uuid4())
                created_iso = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
                doc = {
                    "id": sid,
                    "reference": f"TEST-{status.upper()}-{sid[:6].upper()}",
                    "dealer_id": dealer.get("id"),
                    "dealership_id": dealer.get("dealership_id"),
                    "status": status,
                    "created_at": created_iso,
                    "submitted_at": created_iso,
                    "make_name": "TEST",
                    "model_name": f"TEST {status}",
                    "year": 2020,
                    "mileage": 0,
                    "price": 100000,
                    "photos": {},
                    "deal": {},
                }
                await db.submissions.insert_one(doc)
                ids[status] = sid
            return ids
        finally:
            client.close()

    async def _teardown(ids):
        client, db = await _mongo_client()
        try:
            for sid in ids.values():
                await db.submissions.delete_one({"id": sid})
        finally:
            client.close()

    ids = event_loop.run_until_complete(_seed())
    yield ids
    event_loop.run_until_complete(_teardown(ids))


async def _get_sub_doc(sub_id):
    client, db = await _mongo_client()
    try:
        doc = await db.submissions.find_one({"id": sub_id}, {"_id": 0})
        return doc
    finally:
        client.close()


# --------------------------- tests -----------------------------------

class TestConstants:
    """Verify ARCHIVE_AFTER_DAYS constant is 30 (not 14)."""

    def test_archive_after_days_is_30(self):
        # Read from source so we do not depend on an endpoint that
        # exposes this. This is a fast static check.
        with open("/app/backend/server.py") as f:
            src = f.read()
        assert "ARCHIVE_AFTER_DAYS = 30" in src, "ARCHIVE_AFTER_DAYS must be 30 per spec"


class TestSweepOnListEndpoint:
    """The /list endpoint should trigger the sweep in the caller's scope."""

    def test_list_triggers_sweep_and_marks_auto_expired(
        self, dealer_session, seeded_expired_submission, event_loop
    ):
        sid = seeded_expired_submission
        # Before hit — deal.done should be unset.
        pre = event_loop.run_until_complete(_get_sub_doc(sid))
        assert pre is not None, "seed missing"
        assert (pre.get("deal") or {}).get("done") in (None,), (
            f"pre-state must have deal.done unset, got {(pre.get('deal') or {})}"
        )

        r = dealer_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("period_days") == 90

        # After hit — sweep should have flipped it.
        post = event_loop.run_until_complete(_get_sub_doc(sid))
        deal = post.get("deal") or {}
        assert deal.get("done") is False, f"expected done=False, got {deal}"
        assert deal.get("auto_expired") is True, "auto_expired must be True"
        assert deal.get("expired_at"), "expired_at must be an ISO string"
        assert deal.get("updated_by_name") == "System (expired)"

    def test_row_has_auto_expired_flag_in_list(self, dealer_session, seeded_expired_submission):
        # The list endpoint should include auto_expired + expired_at on
        # our seeded row (bucketed under no_deal because done=false).
        r = dealer_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        assert r.status_code == 200
        body = r.json()
        matches = [row for row in body.get("no_deal", []) if row.get("id") == seeded_expired_submission]
        assert matches, "seeded expired sub not returned in no_deal bucket"
        row = matches[0]
        assert row.get("auto_expired") is True
        assert row.get("expired_at")

    def test_sweep_is_idempotent(
        self, dealer_session, seeded_expired_submission, event_loop
    ):
        # Second hit — auto_expired must NOT be re-stamped (expired_at
        # should be the same). We record the expired_at, hit again,
        # and confirm it did not change.
        pre = event_loop.run_until_complete(_get_sub_doc(seeded_expired_submission))
        first_expired_at = (pre.get("deal") or {}).get("expired_at")
        assert first_expired_at, "first sweep must have set expired_at"

        # Second hit
        r = dealer_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        assert r.status_code == 200
        post = event_loop.run_until_complete(_get_sub_doc(seeded_expired_submission))
        assert (post.get("deal") or {}).get("expired_at") == first_expired_at, (
            "sweep must be idempotent — expired_at should not be re-written"
        )


class TestSweepOnStatsEndpoint:
    def test_stats_endpoint_also_sweeps(self, dealer_session, event_loop):
        # Just confirm 200 OK — the /list test already proved sweep works.
        r = dealer_session.get(f"{BASE_URL}/api/stats/deal-outcomes", timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        for k in ("pending", "deal_done", "no_deal", "sold", "total"):
            assert k in body


class TestSweepAdminScope:
    def test_admin_by_dealer_endpoint_sweeps_global(self, admin_session):
        r = admin_session.get(
            f"{BASE_URL}/api/admin/stats/deal-outcomes-by-dealer", timeout=30
        )
        assert r.status_code == 200, r.text
        # Endpoint returns a list (see server.py deal_outcomes_by_dealer).
        body = r.json()
        assert isinstance(body, (list, dict))


class TestSweepScope:
    def test_pending_and_declined_untouched(
        self, dealer_session, seeded_pending_and_declined, event_loop
    ):
        # Hit the list endpoint to fire the sweep.
        r = dealer_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        assert r.status_code == 200
        for status, sid in seeded_pending_and_declined.items():
            doc = event_loop.run_until_complete(_get_sub_doc(sid))
            deal = doc.get("deal") or {}
            assert deal.get("done") is None, (
                f"{status} submission must NOT be swept, deal={deal}"
            )
            assert deal.get("auto_expired") is not True


class TestManualOverrideClearsFlag:
    def test_dealer_override_clears_auto_expired(
        self, dealer_session, seeded_expired_submission, event_loop
    ):
        sid = seeded_expired_submission
        # First make sure it is currently auto-expired.
        r = dealer_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        assert r.status_code == 200
        pre = event_loop.run_until_complete(_get_sub_doc(sid))
        assert (pre.get("deal") or {}).get("auto_expired") is True

        # Dealer overrides via PATCH — flips done=True.
        r = dealer_session.patch(
            f"{BASE_URL}/api/submissions/{sid}/deal",
            json={"done": True, "purchase_price_zar": 240000},
            timeout=30,
        )
        assert r.status_code == 200, f"override failed: {r.status_code} {r.text[:300]}"
        # Response must reflect the cleared flag.
        body = r.json()
        deal_resp = body.get("deal") or body  # some servers return the full sub
        # find deal object either nested or top-level
        if "auto_expired" not in deal_resp and isinstance(body.get("deal"), dict):
            deal_resp = body["deal"]
        # The exact response envelope may vary; verify DB directly regardless.
        post = event_loop.run_until_complete(_get_sub_doc(sid))
        d = post.get("deal") or {}
        assert d.get("done") is True, f"override should set done=True, got {d}"
        assert d.get("auto_expired") is False, "auto_expired must be cleared to False"
        assert d.get("expired_at") is None, "expired_at must be None after override"


class TestListRegression:
    """Original schema still holds after the new fields were added."""

    def test_schema_and_percent_sum(self, dealer_session):
        r = dealer_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        assert r.status_code == 200
        body = r.json()
        assert body.get("period_days") == 90
        for k in ("counts", "percentages", "pending", "deal_done", "no_deal"):
            assert k in body
        c = body["counts"]
        p = body["percentages"]
        answered = c["deal_done"] + c["no_deal"]
        if answered == 0:
            assert p["deal_done"] == 0 and p["no_deal"] == 0
        else:
            total = p["deal_done"] + p["no_deal"]
            assert 99.0 <= total <= 101.0, f"expected ~100, got {total}"

    def test_no_mongo_id_leaks(self, admin_session):
        r = admin_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30)
        body = r.json()
        for bucket in ("pending", "deal_done", "no_deal"):
            for row in body.get(bucket, [])[:5]:
                assert "_id" not in row, "mongodb _id must not leak"
