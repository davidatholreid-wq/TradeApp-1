"""Edit & Re-submit feature — Aug 2026.

Tests the full backend contract for POST /api/submissions/{id}/resubmit:
  - Auth / ownership / role checks
  - Business rules: must be priced, within 14 days, not already retracted
  - Reference chain: FB-XXX -> FB-XXX-v2 -> FB-XXX-v3
  - Original marked retracted with replaced_by_ref/replaced_by_id
  - /submissions/my hides retracted (bucket='retracted')
  - /history shows retracted with badge fields
  - /stats/deal-outcomes excludes retracted
  - /admin/submissions counts include a 'retracted' bucket
"""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"
DEALER_EMAIL = "dave@fourbuy.co.za"
DEALER_PASSWORD = "Dave1234!"

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "autopricepro_db")

# ---------------------------------------------------------------- fixtures
@pytest.fixture(scope="module")
def mongo():
    client = MongoClient(MONGO_URL)
    return client[DB_NAME]


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def dealer_token(admin_token, mongo):
    r = requests.post(f"{API}/auth/login", json={"email": DEALER_EMAIL, "password": DEALER_PASSWORD}, timeout=15)
    if r.status_code == 200:
        return r.json()["token"]
    # Reset via admin
    dealer = mongo["users"].find_one({"email": DEALER_EMAIL})
    assert dealer, "dealer not found in DB"
    rp = requests.post(
        f"{API}/admin/dealers/{dealer['id']}/password",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"new_password": DEALER_PASSWORD},
        timeout=15,
    )
    assert rp.status_code == 200, rp.text
    r = requests.post(f"{API}/auth/login", json={"email": DEALER_EMAIL, "password": DEALER_PASSWORD}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture
def dealer_hdr(dealer_token):
    return {"Authorization": f"Bearer {dealer_token}", "Content-Type": "application/json"}


@pytest.fixture
def admin_hdr(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


# ------------------------------------------------ payload / seed helpers
def _base_payload(vin_suffix: str = "") -> dict:
    """Minimal-but-complete VehicleSubmission payload."""
    unique = uuid.uuid4().hex[:6].upper()
    return {
        # New style fields per VehicleSubmission model
        "make": "BMW",
        "fuel_type": "Diesel",
        "year_of_production": 2022,
        "transmission": "Automatic",
        "model": f"X5 TEST_{unique}",
        "derivative": "xDrive30d M Sport",
        "year_registered": 2022,
        "colour": "Black",
        "vin": f"TESTVIN{unique}{vin_suffix}"[:17].ljust(17, "0"),
        "engine_number": "TBC",
        "manual_entry": False,
        "unseen": False,
        "mechanical_condition": 8,
        "cosmetic_condition": 7,
        "interior_condition": 8,
        "history_condition": 9,
        "windscreen_condition": "Perfect",
        "service_history": "Full Service History with Agents",
        "factory_warranty_status": "expired",
        "maintenance_plan_status": "expired",
        "service_plan_status": "expired",
        "reconditioning_items": [],
        "photos": {},
        "mileage": 45000,
        "paint_evidence": False,
        "accident_damage": False,
        "billing_accepted": True,
        "license_disk_data": None,
        "license_disk_photo": None,
    }


def _seed_priced_submission(mongo, dealer_email: str, hours_since_priced: float = 1.0) -> dict:
    """Insert a submission that is priced and within (or outside) the resubmit window."""
    dealer = mongo["users"].find_one({"email": dealer_email})
    assert dealer, f"dealer {dealer_email} missing"
    # Get next reference from counters
    r = mongo["counters"].find_one_and_update(
        {"_id": "submission_ref"},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=True,
    )
    ref = f"FB-{r['seq']:06d}"
    now = datetime.now(timezone.utc)
    priced_at = now - timedelta(hours=hours_since_priced)
    sub_id = str(uuid.uuid4())
    doc = {
        "id": sub_id,
        "reference": ref,
        "dealer_id": dealer["id"],
        "dealership_id": dealer.get("dealership_id"),
        "status": "priced",
        "created_at": (now - timedelta(hours=hours_since_priced + 1)).isoformat(),
        "submitted_at": (now - timedelta(hours=hours_since_priced + 1)).isoformat(),
        "priced_at": priced_at.isoformat(),
        "price": 500000,
        "make": "BMW",
        "model": "TEST X5",
        "year_of_production": 2022,
        "year_registered": 2022,
        "vin": f"TESTSEED{uuid.uuid4().hex[:9].upper()}"[:17],
        "mileage": 45000,
        "colour": "Black",
        "reconditioning_items": [],
        "photos": {},
        "billing_accepted": True,
        "version": 1,
    }
    mongo["submissions"].insert_one(doc)
    return doc


@pytest.fixture
def cleanup(mongo):
    ids = []
    yield ids
    if ids:
        mongo["submissions"].delete_many({"id": {"$in": ids}})


# ============================================================== tests
class TestResubmitAuth:
    def test_requires_auth(self):
        r = requests.post(f"{API}/submissions/does-not-exist/resubmit", json=_base_payload(), timeout=15)
        assert r.status_code in (401, 403)

    def test_admin_forbidden(self, admin_hdr, mongo, cleanup):
        # Any sub is fine, admin should be blocked before ownership check
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        r = requests.post(f"{API}/submissions/{seed['id']}/resubmit", json=_base_payload(), headers=admin_hdr, timeout=15)
        assert r.status_code == 403

    def test_missing_submission_404(self, dealer_hdr):
        r = requests.post(f"{API}/submissions/{uuid.uuid4()}/resubmit", json=_base_payload(), headers=dealer_hdr, timeout=15)
        assert r.status_code == 404


class TestResubmitBusinessRules:
    def test_reject_when_not_priced(self, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        mongo["submissions"].update_one({"id": seed["id"]}, {"$set": {"status": "pending"}, "$unset": {"priced_at": ""}})
        r = requests.post(f"{API}/submissions/{seed['id']}/resubmit", json=_base_payload(), headers=dealer_hdr, timeout=15)
        assert r.status_code == 409
        assert "priced" in r.text.lower()

    def test_reject_when_outside_window(self, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL, hours_since_priced=15 * 24)  # 15 days
        cleanup.append(seed["id"])
        r = requests.post(f"{API}/submissions/{seed['id']}/resubmit", json=_base_payload(), headers=dealer_hdr, timeout=15)
        assert r.status_code == 409
        assert "window" in r.text.lower() or "14" in r.text

    def test_reject_when_already_retracted(self, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        mongo["submissions"].update_one({"id": seed["id"]}, {"$set": {"retracted": True}})
        r = requests.post(f"{API}/submissions/{seed['id']}/resubmit", json=_base_payload(), headers=dealer_hdr, timeout=15)
        assert r.status_code == 409
        assert "retracted" in r.text.lower()

    def test_reject_missing_billing_acceptance(self, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        p = _base_payload()
        p["billing_accepted"] = False
        r = requests.post(f"{API}/submissions/{seed['id']}/resubmit", json=p, headers=dealer_hdr, timeout=15)
        assert r.status_code == 400


class TestResubmitHappyPath:
    def test_first_resubmit_creates_v2_and_retracts_original(self, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        base_ref = seed["reference"]
        p = _base_payload()
        p["mileage"] = 55555
        p["colour"] = "Alpine White"
        r = requests.post(f"{API}/submissions/{seed['id']}/resubmit", json=p, headers=dealer_hdr, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["reference"] == f"{base_ref}-v2"
        assert data["retracted_ref"] == base_ref
        new_id = data["id"]
        cleanup.append(new_id)

        # Verify new doc in DB
        new_doc = mongo["submissions"].find_one({"id": new_id})
        assert new_doc["reference"] == f"{base_ref}-v2"
        assert new_doc["replaces_ref"] == base_ref
        assert new_doc["replaces_id"] == seed["id"]
        assert new_doc["original_ref"] == base_ref
        assert new_doc["version"] == 2
        assert new_doc["mileage"] == 55555
        assert new_doc["colour"] == "Alpine White"
        assert new_doc.get("retracted") is not True
        assert new_doc["status"] == "pending"

        # Verify original retracted
        orig = mongo["submissions"].find_one({"id": seed["id"]})
        assert orig["retracted"] is True
        assert orig.get("retracted_at")
        assert orig.get("retracted_by")
        assert orig["replaced_by_ref"] == f"{base_ref}-v2"
        assert orig["replaced_by_id"] == new_id
        assert orig["original_ref"] == base_ref

    def test_second_resubmit_creates_v3(self, dealer_hdr, admin_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        base_ref = seed["reference"]
        # first resubmit -> v2
        r1 = requests.post(f"{API}/submissions/{seed['id']}/resubmit", json=_base_payload(), headers=dealer_hdr, timeout=30)
        assert r1.status_code == 200, r1.text
        v2_id = r1.json()["id"]
        cleanup.append(v2_id)
        assert r1.json()["reference"] == f"{base_ref}-v2"

        # price v2 by admin
        pr = requests.post(
            f"{API}/admin/submissions/{v2_id}/price",
            json={"price": 480000},
            headers=admin_hdr,
            timeout=15,
        )
        assert pr.status_code == 200, pr.text

        # second resubmit -> v3
        r2 = requests.post(f"{API}/submissions/{v2_id}/resubmit", json=_base_payload(), headers=dealer_hdr, timeout=30)
        assert r2.status_code == 200, r2.text
        assert r2.json()["reference"] == f"{base_ref}-v3"
        v3_id = r2.json()["id"]
        cleanup.append(v3_id)
        v3 = mongo["submissions"].find_one({"id": v3_id})
        assert v3["version"] == 3
        assert v3["original_ref"] == base_ref
        assert v3["replaces_ref"] == f"{base_ref}-v2"
        assert v3["replaces_id"] == v2_id

    def test_photos_preserved_on_resubmit(self, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        # Simulate cloudinary URLs already stored in payload
        p = _base_payload()
        cloud_url = "https://res.cloudinary.com/xtdqmu7n/image/upload/v1/fourbuy/test.jpg"
        p["photos"] = {"front": cloud_url, "rear": cloud_url}
        r = requests.post(f"{API}/submissions/{seed['id']}/resubmit", json=p, headers=dealer_hdr, timeout=30)
        assert r.status_code == 200, r.text
        new_id = r.json()["id"]
        cleanup.append(new_id)
        new_doc = mongo["submissions"].find_one({"id": new_id})
        assert new_doc["photos"]["front"] == cloud_url
        assert new_doc["photos"]["rear"] == cloud_url


class TestResubmitListingsFilter:
    def test_my_submissions_hides_retracted(self, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        r = requests.post(f"{API}/submissions/{seed['id']}/resubmit", json=_base_payload(), headers=dealer_hdr, timeout=30)
        assert r.status_code == 200
        new_id = r.json()["id"]
        cleanup.append(new_id)

        my = requests.get(f"{API}/submissions/my", headers=dealer_hdr, timeout=15)
        assert my.status_code == 200
        refs = [s["reference"] for s in my.json()["submissions"]]
        assert seed["reference"] not in refs, "retracted original should NOT appear in My Evaluations"
        assert f"{seed['reference']}-v2" in refs, "new -v2 should appear in My Evaluations"

    def test_history_shows_retracted_with_metadata(self, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        r = requests.post(f"{API}/submissions/{seed['id']}/resubmit", json=_base_payload(), headers=dealer_hdr, timeout=30)
        assert r.status_code == 200
        new_id = r.json()["id"]
        cleanup.append(new_id)

        hist = requests.get(f"{API}/history", headers=dealer_hdr, timeout=15)
        assert hist.status_code == 200
        by_ref = {s["reference"]: s for s in hist.json()["submissions"]}
        assert seed["reference"] in by_ref, "retracted original should still appear in /history"
        orig = by_ref[seed["reference"]]
        assert orig.get("retracted") is True
        assert orig.get("replaced_by_ref") == f"{seed['reference']}-v2"
        assert orig.get("bucket") == "retracted"
        # v2 should show replaces_ref
        v2 = by_ref.get(f"{seed['reference']}-v2")
        assert v2 is not None
        assert v2.get("replaces_ref") == seed["reference"]

    def test_deal_outcomes_excludes_retracted(self, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        # Mark original with a deal outcome so if it weren't filtered it would count
        mongo["submissions"].update_one(
            {"id": seed["id"]},
            {"$set": {"deal": {"done": True, "sold": True, "profit_zar": 10000}}},
        )
        before = requests.get(f"{API}/stats/deal-outcomes", headers=dealer_hdr, timeout=15).json()

        r = requests.post(f"{API}/submissions/{seed['id']}/resubmit", json=_base_payload(), headers=dealer_hdr, timeout=30)
        assert r.status_code == 200
        new_id = r.json()["id"]
        cleanup.append(new_id)

        after = requests.get(f"{API}/stats/deal-outcomes", headers=dealer_hdr, timeout=15).json()
        # after retraction the deal_done+sold from the original must NOT persist
        # It contributed one deal_done + one sold before retraction
        assert after["deal_done"] == before["deal_done"] - 1
        assert after["sold"] == before["sold"] - 1

    def test_admin_counts_include_retracted_bucket(self, admin_hdr, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        r = requests.post(f"{API}/submissions/{seed['id']}/resubmit", json=_base_payload(), headers=dealer_hdr, timeout=30)
        assert r.status_code == 200
        new_id = r.json()["id"]
        cleanup.append(new_id)

        counts_only = requests.get(f"{API}/admin/submissions/counts", headers=admin_hdr, timeout=15)
        assert counts_only.status_code == 200
        counts = counts_only.json()["counts"]
        assert "retracted" in counts
        assert counts["retracted"] >= 1

        full = requests.get(f"{API}/admin/submissions", headers=admin_hdr, timeout=30)
        assert full.status_code == 200
        payload = full.json()
        assert "retracted" in payload["counts"]
        assert payload["counts"]["retracted"] >= 1
        # Retracted sub must have bucket='retracted' in the returned list too
        retracted_in_list = [s for s in payload["submissions"] if s["id"] == seed["id"]]
        assert retracted_in_list and retracted_in_list[0]["bucket"] == "retracted"


# ==================== NEW: Stock-linked resubmit (Aug 2026) ====================
class TestResubmitStockInteraction:
    """Iteration 60 refinement — resubmit must:
      - Hard-stop with 409 when linked stock item has sold=True
      - Auto-delete stock item + unset stock fields on the retracted
        submission when the stock item is NOT sold.
    """

    def _seed_stock_item(self, mongo, submission_doc: dict, *, sold: bool = False,
                        stock_number: str = "STK-TEST") -> dict:
        """Insert a stock_items row + link on the submission."""
        sid = str(uuid.uuid4())
        now_iso = datetime.now(timezone.utc).isoformat()
        item = {
            "id": sid,
            "dealership_id": submission_doc.get("dealership_id"),
            "dealer_id": submission_doc.get("dealer_id"),
            "submission_id": submission_doc["id"],
            "stock_number": stock_number,
            "target_sell_price_zar": 550000,
            "year": submission_doc.get("year_of_production"),
            "make_name": submission_doc.get("make"),
            "model_name": submission_doc.get("model"),
            "vin": submission_doc.get("vin"),
            "mileage": submission_doc.get("mileage"),
            "sold": sold,
            "sold_at": now_iso if sold else None,
            "created_at": now_iso,
            "updated_at": now_iso,
        }
        mongo["stock_items"].insert_one(item)
        mongo["submissions"].update_one(
            {"id": submission_doc["id"]},
            {"$set": {
                "stock_item_id": sid,
                "stock_number": stock_number,
                "transferred_to_stock_at": now_iso,
                "transferred_to_stock_by": submission_doc.get("dealer_id"),
            }},
        )
        return item

    def test_resubmit_blocked_when_stock_sold(self, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        stock = self._seed_stock_item(mongo, seed, sold=True, stock_number="STK-SOLD-1")
        try:
            r = requests.post(
                f"{API}/submissions/{seed['id']}/resubmit",
                json=_base_payload(),
                headers=dealer_hdr,
                timeout=30,
            )
            assert r.status_code == 409, r.text
            body = r.text.lower()
            assert "sold" in body, f"expected sold-stock message, got: {r.text}"
            # Original must still exist and NOT be retracted
            orig = mongo["submissions"].find_one({"id": seed["id"]})
            assert orig.get("retracted") is not True
            # Stock item must still exist
            assert mongo["stock_items"].find_one({"id": stock["id"]}) is not None
        finally:
            mongo["stock_items"].delete_one({"id": stock["id"]})

    def test_resubmit_untransfers_stock_when_not_sold(self, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        stock = self._seed_stock_item(mongo, seed, sold=False, stock_number="STK-LIVE-1")
        try:
            r = requests.post(
                f"{API}/submissions/{seed['id']}/resubmit",
                json=_base_payload(),
                headers=dealer_hdr,
                timeout=30,
            )
            assert r.status_code == 200, r.text
            new_id = r.json()["id"]
            cleanup.append(new_id)

            # 1. stock_items collection must no longer contain the item
            assert mongo["stock_items"].find_one({"id": stock["id"]}) is None, \
                "non-sold stock item should be deleted on resubmit"

            # 2. Original submission is retracted AND has stock fields cleared
            orig = mongo["submissions"].find_one({"id": seed["id"]})
            assert orig["retracted"] is True
            assert "stock_item_id" not in orig, f"stock_item_id should be unset, doc: {orig.keys()}"
            assert "stock_number" not in orig
            assert "transferred_to_stock_at" not in orig
            assert "transferred_to_stock_by" not in orig
        finally:
            # Belt & braces cleanup in case the delete_one above didn't run.
            mongo["stock_items"].delete_one({"id": stock["id"]})

    def test_stock_list_excludes_removed_item_after_resubmit(self, dealer_hdr, mongo, cleanup):
        seed = _seed_priced_submission(mongo, DEALER_EMAIL)
        cleanup.append(seed["id"])
        stock = self._seed_stock_item(mongo, seed, sold=False, stock_number="STK-LIVE-2")
        try:
            # Pre-check: GET /stock includes it
            before = requests.get(f"{API}/stock", headers=dealer_hdr, timeout=15)
            assert before.status_code == 200, before.text
            ids_before = [s["id"] for s in before.json().get("stock", before.json().get("items", []))]
            # /stock may return under 'stock' or 'items' key — handle either
            # depending on schema. Just check we can find our item somehow.
            all_before_ids = str(before.json())
            assert stock["id"] in all_before_ids, "seeded stock item should appear in /stock before resubmit"

            r = requests.post(
                f"{API}/submissions/{seed['id']}/resubmit",
                json=_base_payload(),
                headers=dealer_hdr,
                timeout=30,
            )
            assert r.status_code == 200, r.text
            new_id = r.json()["id"]
            cleanup.append(new_id)

            after = requests.get(f"{API}/stock", headers=dealer_hdr, timeout=15)
            assert after.status_code == 200
            all_after_ids = str(after.json())
            assert stock["id"] not in all_after_ids, "stock item should be GONE from /stock after resubmit"
        finally:
            mongo["stock_items"].delete_one({"id": stock["id"]})
