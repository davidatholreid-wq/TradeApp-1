"""Verify that the 'Subject to View' (unseen=True) flag on a submission
removes the CONDITION ASSESSMENT / SERVICE / RECONDITIONING sections from
the generated valuation PDF entirely, while a normal submission keeps them.

Regression: also confirms the red 'VEHICLE UNSEEN — SUBJECT TO VIEW'
banner is still rendered for unseen submissions.
"""
import io
import os
import uuid

import pytest
import requests
from pypdf import PdfReader

BASE_URL = os.environ.get(
    "EXPO_PUBLIC_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com"
).rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"

# 1x1 transparent PNG (data URL) — satisfies base64 image validation
TINY_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)
PHOTO_KEYS = [
    "front", "driver_side", "passenger_side", "rear",
    "engine_bay", "interior_front", "interior_back", "boot", "dash_odo",
]
PHOTOS = {k: TINY_PNG for k in PHOTO_KEYS}


# ------------------------------ fixtures ------------------------------
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{API}/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text[:200]}"
    j = r.json()
    return j.get("token") or j.get("access_token")


@pytest.fixture(scope="module")
def dealer_ctx():
    """Login existing dealer (minitest); dealer self-register is admin-only now."""
    r = requests.post(
        f"{API}/auth/login",
        json={"email": "minitest@example.com", "password": "Mini1234!"},
        timeout=30,
    )
    assert r.status_code == 200, f"Dealer login failed: {r.status_code} {r.text[:200]}"
    j = r.json()
    token = j["token"]
    user_id = j["user"]["id"]

    # accept billing agreement (idempotent)
    requests.post(
        f"{API}/agreement/accept",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    return {"token": token, "id": user_id, "email": "minitest@example.com"}


@pytest.fixture(scope="module")
def vehicle_spec():
    """Pick a valid make/model/derivative triple from the API."""
    makes = requests.get(f"{API}/vehicles/makes", timeout=30).json()["makes"]
    mk = next((m for m in makes if m["name"] == "BMW"), makes[0])
    models = requests.get(
        f"{API}/vehicles/models", params={"make_id": mk["id"]}, timeout=30
    ).json()["models"]
    md = models[0]
    derivs = requests.get(
        f"{API}/vehicles/derivatives", params={"model_id": md["id"]}, timeout=30
    ).json()["derivatives"]
    dv = derivs[0]
    return {
        "make_id": mk["id"], "make_name": mk["name"], "make": mk["name"],
        "model_id": md["id"], "model_name": md["name"], "model": md["name"],
        "derivative_id": dv["id"], "derivative_name": dv["name"], "derivative": dv["name"],
    }


def _base_payload(spec: dict) -> dict:
    return {
        **spec,
        "mileage": 45000,
        "year": 2021,
        "year_of_production": 2021,
        "year_registered": 2021,
        "fuel_type": "Petrol",
        "transmission": "Automatic",
        "factory_warranty": True,
        "condition": 8,
        "colour": "Black",
        "billing_accepted": True,
        "vin": "WBA5A5C58ED123456",
        "engine_number": "N20B20A123456",
        "reconditioning_items": [
            {"description": "Front tyres replacement", "amount_zar": 4500},
            {"description": "Windscreen chip repair", "amount_zar": 750},
        ],
        "photos": PHOTOS,
    }


def _extract_pdf_text(content: bytes) -> str:
    assert content[:5] == b"%PDF-", f"Not a PDF (got {content[:8]!r})"
    reader = PdfReader(io.BytesIO(content))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


def _price_submission(admin_token: str, sub_id: str, price: int = 400000) -> None:
    """Admin prices the submission so the valuation PDF becomes downloadable."""
    r = requests.post(
        f"{API}/admin/submissions/{sub_id}/price",
        json={"price": price, "notes": "TEST_unseen_pdf"},
        headers={"Authorization": f"Bearer {admin_token}"},
        timeout=60,
    )
    assert r.status_code in (200, 201), f"Price failed: {r.status_code} {r.text[:200]}"


# ------------------------- submission creation -------------------------
@pytest.fixture(scope="module")
def unseen_sub(dealer_ctx, vehicle_spec):
    payload = _base_payload(vehicle_spec)
    payload.update({
        "unseen": True,
        # defaults 5 for ratings — required to satisfy schema
        "mechanical_condition": 5,
        "cosmetic_condition": 5,
        "interior_condition": 5,
        "history_condition": 5,
        # unseen ⇒ leave optional fields empty
    })
    r = requests.post(
        f"{API}/submissions",
        json=payload,
        headers={"Authorization": f"Bearer {dealer_ctx['token']}"},
        timeout=60,
    )
    assert r.status_code in (200, 201), f"Create UNSEEN failed: {r.status_code} {r.text[:400]}"
    raw = r.json()
    body = raw.get("submission", raw)
    body["id"] = body.get("id") or raw.get("id")
    assert body.get("unseen") is True, f"Returned submission.unseen != True → {body.get('unseen')!r}"
    return body


@pytest.fixture(scope="module")
def seen_sub(dealer_ctx, vehicle_spec):
    payload = _base_payload(vehicle_spec)
    payload.update({
        "unseen": False,
        "mechanical_condition": 8,
        "cosmetic_condition": 7,
        "interior_condition": 9,
        "history_condition": 6,
        "exterior_condition": 8,
        "tyre_condition": 7,
        "windscreen_condition": "Perfect",
        "service_history": "Full Service History with Agents",
        "paint_evidence": False,
        "accident_damage": False,
        "last_service_date": "2025-11-15",
        "service_mileage": 40000,
    })
    r = requests.post(
        f"{API}/submissions",
        json=payload,
        headers={"Authorization": f"Bearer {dealer_ctx['token']}"},
        timeout=60,
    )
    assert r.status_code in (200, 201), f"Create SEEN failed: {r.status_code} {r.text[:400]}"
    raw = r.json()
    body = raw.get("submission", raw)
    body["id"] = body.get("id") or raw.get("id")
    assert body.get("unseen") in (False, None), f"seen sub returned unseen={body.get('unseen')!r}"
    return body


# ------------------------------ tests ------------------------------
def test_unseen_submission_created(unseen_sub):
    assert unseen_sub["id"]
    assert unseen_sub["unseen"] is True


def test_unseen_pdf_hides_condition_sections(admin_token, unseen_sub):
    _price_submission(admin_token, unseen_sub["id"])
    r = requests.get(
        f"{API}/submissions/{unseen_sub['id']}/valuation.pdf",
        headers={"Authorization": f"Bearer {admin_token}"},
        timeout=90,
    )
    assert r.status_code == 200, f"PDF fetch failed: {r.status_code} {r.text[:200]}"
    text = _extract_pdf_text(r.content)
    norm = " ".join(text.split())

    # dump to /tmp for debugging
    with open("/tmp/unseen_pdf.txt", "w") as f:
        f.write(text)

    # POSITIVE: banner must be present
    # (em-dash vs hyphen — check both forms of the phrase substring)
    assert (
        "VEHICLE UNSEEN" in norm and "SUBJECT TO VIEW" in norm
    ), f"Unseen banner missing.\n--- extracted ---\n{text[:1500]}"

    # NEGATIVE: none of the condition/service/recon labels may appear
    banned = [
        "CONDITION ASSESSMENT",
        "Overall Condition",
        "Mechanical (30%)",
        "Cosmetic (25%)",
        "Interior (25%)",
        "General (20%)",
        "SERVICE HISTORY",
        "RECONDITIONING",
        "Windscreen",
        "Paint Evidence",
        "Accident Damage",
    ]
    hits = [b for b in banned if b in norm]
    assert not hits, (
        f"Unseen PDF still contains banned labels: {hits}\n"
        f"--- extracted (first 2000 chars) ---\n{text[:2000]}"
    )


def test_seen_pdf_contains_condition_sections(admin_token, seen_sub):
    _price_submission(admin_token, seen_sub["id"])
    r = requests.get(
        f"{API}/submissions/{seen_sub['id']}/valuation.pdf",
        headers={"Authorization": f"Bearer {admin_token}"},
        timeout=90,
    )
    assert r.status_code == 200, f"PDF fetch failed: {r.status_code} {r.text[:200]}"
    text = _extract_pdf_text(r.content)
    norm = " ".join(text.split())

    with open("/tmp/seen_pdf.txt", "w") as f:
        f.write(text)

    required = [
        "CONDITION ASSESSMENT",
        "Overall Condition",
        "Mechanical (30%)",
        "Cosmetic (25%)",
    ]
    missing = [r for r in required if r not in norm]
    assert not missing, (
        f"Regression: SEEN PDF missing expected labels: {missing}\n"
        f"--- extracted (first 2000 chars) ---\n{text[:2000]}"
    )

    # banner must NOT be present for seen submissions
    assert "VEHICLE UNSEEN" not in norm, "Unseen banner leaked into a SEEN submission's PDF"
