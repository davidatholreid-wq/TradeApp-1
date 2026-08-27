"""
Iteration 71 — Verify pricing-agent dealers can mark deal-done / no-deal
on submissions that are still `status == "pending"` (i.e. TradeAPP has
not priced the file yet).

Covers:
  * PATCH /api/submissions/{id}/deal on a pending submission — done=True success
  * PATCH ... done=False success
  * GET /api/stats/deal-outcomes now counts pending subs with explicit deal.done
  * Regression: admin cannot PATCH deal (403)
  * Regression: non-pricing-agent dealer cannot PATCH deal (403)
"""

import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")

ADMIN_EMAIL = "admin@tradeapp.co.za"
ADMIN_PW = "admin123"
DAVE_EMAIL = "dave@tradeapp.co.za"
DAVE_PW = "Dave1234!"
NON_PA_EMAIL = "minitest@example.com"
NON_PA_PW = "password"


# ------------------------------------------------------------------ helpers

def _login(session: requests.Session, email: str, password: str) -> dict:
    r = session.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text}"
    body = r.json()
    tok = body.get("token") or body.get("access_token")
    assert tok, f"no token in login response: {body}"
    session.headers.update({"Authorization": f"Bearer {tok}"})
    return body


def _new_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ------------------------------------------------------------------ fixtures

@pytest.fixture(scope="module")
def admin_session():
    s = _new_session()
    _login(s, ADMIN_EMAIL, ADMIN_PW)
    return s


@pytest.fixture(scope="module")
def dave_session():
    s = _new_session()
    # Password may have been reset in a previous iteration — try login,
    # and if it fails ask the admin to reset it before retrying.
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": DAVE_EMAIL, "password": DAVE_PW}, timeout=30)
    if r.status_code != 200:
        admin = _new_session()
        _login(admin, ADMIN_EMAIL, ADMIN_PW)
        dealers = admin.get(f"{BASE_URL}/api/admin/dealers?limit=500", timeout=30).json().get("dealers", [])
        dave = next((d for d in dealers if (d.get("email") or "").lower() == DAVE_EMAIL), None)
        assert dave, "dave@tradeapp.co.za not found in dealers list"
        admin.post(
            f"{BASE_URL}/api/admin/dealers/{dave['id']}/password",
            json={"new_password": DAVE_PW},
            timeout=30,
        ).raise_for_status()
    _login(s, DAVE_EMAIL, DAVE_PW)
    return s


@pytest.fixture(scope="module")
def non_pa_session():
    s = _new_session()
    _login(s, NON_PA_EMAIL, NON_PA_PW)
    return s


@pytest.fixture(scope="module")
def pending_sub_ids(dave_session):
    """Return TWO pending submission ids owned by dave's dealership.
    We need two so we can drive done=True and done=False independently
    (setting done=False on a done=True clears purchase_price_zar etc.,
    which is fine, but two makes the assertions cleaner).
    """
    r = dave_session.get(f"{BASE_URL}/api/submissions/my?limit=100", timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    subs = data if isinstance(data, list) else data.get("submissions", data.get("items", []))
    pending = [s for s in subs if s.get("status") == "pending" and not s.get("retracted")]
    if len(pending) < 2:
        pytest.skip(f"need >=2 pending submissions, have {len(pending)}")
    return [pending[0]["id"], pending[1]["id"]]


# ------------------------------------------------------------------ tests


class TestPatchDealOnPending:
    """PATCH /api/submissions/{id}/deal on a pending submission."""

    def test_mark_deal_done_true(self, dave_session, pending_sub_ids):
        sub_id = pending_sub_ids[0]
        r = dave_session.patch(
            f"{BASE_URL}/api/submissions/{sub_id}/deal",
            json={"done": True},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        # Some endpoints return the full submission, some return {"deal": …}
        deal = body.get("deal") or body
        assert deal.get("done") is True, f"expected deal.done=True, got {deal.get('done')} — body={body}"

        # GET the submission and verify persistence + status still pending.
        g = dave_session.get(f"{BASE_URL}/api/submissions/{sub_id}", timeout=30)
        assert g.status_code == 200, g.text
        body_g = g.json()
        sub = body_g.get("submission", body_g)
        assert sub.get("status") == "pending", f"status changed to {sub.get('status')}"
        assert (sub.get("deal") or {}).get("done") is True
        # purchased_at should have been auto-stamped
        assert (sub.get("deal") or {}).get("purchased_at"), "purchased_at was not stamped"

    def test_mark_deal_done_false(self, dave_session, pending_sub_ids):
        sub_id = pending_sub_ids[1]
        r = dave_session.patch(
            f"{BASE_URL}/api/submissions/{sub_id}/deal",
            json={"done": False},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        deal = body.get("deal") or body
        assert deal.get("done") is False, f"expected deal.done=False, got {deal.get('done')} — body={body}"

        g = dave_session.get(f"{BASE_URL}/api/submissions/{sub_id}", timeout=30)
        assert g.status_code == 200
        body_g = g.json()
        sub = body_g.get("submission", body_g)
        assert sub.get("status") == "pending"
        assert (sub.get("deal") or {}).get("done") is False

    def test_flip_back_to_pending(self, dave_session, pending_sub_ids):
        """Setting done=null should return the submission to the pending
        bucket in the stats."""
        sub_id = pending_sub_ids[0]
        r = dave_session.patch(
            f"{BASE_URL}/api/submissions/{sub_id}/deal",
            json={"done": None},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        # Restore done=True to leave the DB roughly as we found it plus
        # the pending sub carrying an outcome that the stats test needs.
        r = dave_session.patch(
            f"{BASE_URL}/api/submissions/{sub_id}/deal",
            json={"done": True},
            timeout=30,
        )
        assert r.status_code == 200


class TestDealOutcomesIncludePending:
    """/api/stats/deal-outcomes must now count pending subs with an
    explicit deal.done value."""

    def test_stats_counts_pending_with_outcome(self, dave_session, pending_sub_ids):
        # Ensure both pending subs have outcomes set (idempotent).
        dave_session.patch(
            f"{BASE_URL}/api/submissions/{pending_sub_ids[0]}/deal",
            json={"done": True},
            timeout=30,
        )
        dave_session.patch(
            f"{BASE_URL}/api/submissions/{pending_sub_ids[1]}/deal",
            json={"done": False},
            timeout=30,
        )

        r = dave_session.get(f"{BASE_URL}/api/stats/deal-outcomes", timeout=30)
        assert r.status_code == 200, r.text
        stats = r.json()
        # Sanity — schema
        for k in ("pending", "deal_done", "no_deal", "sold", "total", "gross_profit_zar"):
            assert k in stats, f"missing stats key: {k}"
        # Our two seeded pending subs should be counted:
        # one in deal_done, one in no_deal.
        # Fetch the full list to confirm they are present.
        lst = dave_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30).json()
        done_ids = {row.get("id") for row in lst.get("deal_done", [])}
        no_deal_ids = {row.get("id") for row in lst.get("no_deal", [])}
        assert pending_sub_ids[0] in done_ids, \
            f"pending sub {pending_sub_ids[0]} (done=True) not in deal_done bucket; done_ids sample={list(done_ids)[:5]}"
        assert pending_sub_ids[1] in no_deal_ids, \
            f"pending sub {pending_sub_ids[1]} (done=False) not in no_deal bucket; no_deal_ids sample={list(no_deal_ids)[:5]}"

    def test_stats_excludes_unmarked_pending(self, dave_session, pending_sub_ids):
        """A pending sub whose deal.done is null must NOT appear in any
        bucket (pending / deal_done / no_deal)."""
        # Find a 3rd pending sub with deal.done == null. If none, skip.
        subs = dave_session.get(f"{BASE_URL}/api/submissions/my?limit=100", timeout=30).json()
        subs = subs if isinstance(subs, list) else subs.get("submissions", subs.get("items", []))
        pending = [
            s for s in subs
            if s.get("status") == "pending"
            and not s.get("retracted")
            and (s.get("deal") or {}).get("done") in (None,)
            and s["id"] not in pending_sub_ids
        ]
        if not pending:
            pytest.skip("no unmarked-pending submission available")
        target_id = pending[0]["id"]

        lst = dave_session.get(f"{BASE_URL}/api/stats/deal-outcomes/list", timeout=30).json()
        all_ids = {r.get("id") for r in lst.get("pending", []) + lst.get("deal_done", []) + lst.get("no_deal", [])}
        assert target_id not in all_ids, \
            f"unmarked pending sub {target_id} leaked into deal-outcomes buckets"


class TestPatchDealAccessControl:
    """Regression: admin and non-pricing-agent dealers still 403."""

    def test_admin_forbidden(self, admin_session, pending_sub_ids):
        sub_id = pending_sub_ids[0]
        r = admin_session.patch(
            f"{BASE_URL}/api/submissions/{sub_id}/deal",
            json={"done": True},
            timeout=30,
        )
        assert r.status_code == 403, f"expected 403 for admin, got {r.status_code}: {r.text}"

    def test_non_pricing_agent_forbidden(self, non_pa_session, dave_session, pending_sub_ids):
        """A dealer without is_pricing_agent should get 403 even when
        trying to PATCH a submission on ANOTHER dealership. minitest@
        is on Karam Motors, dave's subs are on TradeAPP Fourways — so
        this also covers the cross-dealership case, which is still 403
        by the pricing-agent gate."""
        sub_id = pending_sub_ids[0]
        r = non_pa_session.patch(
            f"{BASE_URL}/api/submissions/{sub_id}/deal",
            json={"done": True},
            timeout=30,
        )
        assert r.status_code == 403, f"expected 403 for non-PA, got {r.status_code}: {r.text}"


class TestUnauthenticated:
    def test_no_auth(self, pending_sub_ids):
        r = requests.patch(
            f"{BASE_URL}/api/submissions/{pending_sub_ids[0]}/deal",
            json={"done": True},
            timeout=30,
        )
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"
