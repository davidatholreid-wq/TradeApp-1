"""Tests for the KREDO MARKET VALUES section in the valuation PDF export.

Covers:
  - Admin can download PDF for FB-000093, and section is present + contains
    New List Price, M&M Code (60039244), Trade/Retail labels + footer.
  - Footer contains "Source: Kredo Vehicle Values" + "locked at valuation".
  - Auth regressions: 401 without token, 403 for non-owner dealer.
  - Submission without market_values (status != 'ok') still returns 200 PDF
    without the KREDO section (no crash).
"""
import io
import os
import pytest
import requests
from pypdf import PdfReader

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"
DEALER_EMAIL = "minitest@example.com"
DEALER_PASSWORD = "Mini1234!"

TARGET_REF = "FB-000093"
EXPECTED_MM_CODE = "60039244"


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    j = r.json()
    return j.get("token") or j.get("access_token")


@pytest.fixture(scope="module")
def dealer_token():
    r = requests.post(f"{API}/auth/login", json={"email": DEALER_EMAIL, "password": DEALER_PASSWORD}, timeout=30)
    if r.status_code != 200:
        pytest.skip(f"Dealer login failed ({r.status_code}); can't run non-owner 403 case")
    j = r.json()
    return j.get("token") or j.get("access_token")


@pytest.fixture(scope="module")
def target_sub_id(admin_token):
    """Locate FB-000093 submission id via admin listing."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = requests.get(f"{API}/admin/submissions", headers=headers, timeout=30)
    assert r.status_code == 200, f"admin/submissions failed: {r.status_code} {r.text[:200]}"
    subs = r.json().get("submissions") or []
    for s in subs:
        if s.get("reference") == TARGET_REF or s.get("ref_no") == TARGET_REF:
            return s.get("id")
    pytest.skip(f"Could not find submission {TARGET_REF} (found {len(subs)} subs)")


# ---------- happy path: PDF contains KREDO section ----------
def _extract_pdf_text(content: bytes) -> str:
    assert content[:5] == b"%PDF-", f"Not a PDF (starts with {content[:8]!r})"
    reader = PdfReader(io.BytesIO(content))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


def test_admin_pdf_has_kredo_section(admin_token, target_sub_id):
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = requests.get(f"{API}/submissions/{target_sub_id}/valuation.pdf", headers=headers, timeout=60)
    assert r.status_code == 200, f"PDF download failed: {r.status_code} {r.text[:200]}"
    assert r.headers.get("content-type", "").startswith("application/pdf"), r.headers.get("content-type")
    text = _extract_pdf_text(r.content)

    # Store extracted text for debugging
    with open("/tmp/fb093_pdf.txt", "w") as f:
        f.write(text)

    # PDF text extraction can collapse whitespace / split lines. Do simple
    # substring checks after normalising spaces.
    norm = " ".join(text.split())
    for label in ("KREDO MARKET VALUES", "New List Price", "M&M Code", "Trade Value", "Retail Value"):
        assert label in norm, f"Label '{label}' missing from PDF text.\n--- extracted ---\n{text[:2000]}"


def test_admin_pdf_contains_mm_code_and_footer(admin_token, target_sub_id):
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = requests.get(f"{API}/submissions/{target_sub_id}/valuation.pdf", headers=headers, timeout=60)
    assert r.status_code == 200
    text = _extract_pdf_text(r.content)
    norm = " ".join(text.split())

    assert EXPECTED_MM_CODE in norm, f"M&M code {EXPECTED_MM_CODE} missing from PDF"
    assert "Source: Kredo Vehicle Values" in norm, "Provenance footer missing"
    assert "locked at valuation" in norm, "'locked at valuation' footer text missing"


# ---------- auth regressions ----------
def test_pdf_requires_auth(target_sub_id):
    r = requests.get(f"{API}/submissions/{target_sub_id}/valuation.pdf", timeout=30)
    assert r.status_code == 401, f"Expected 401 without auth, got {r.status_code}"


def test_pdf_forbidden_for_non_owner_dealer(dealer_token, target_sub_id):
    headers = {"Authorization": f"Bearer {dealer_token}"}
    r = requests.get(f"{API}/submissions/{target_sub_id}/valuation.pdf", headers=headers, timeout=30)
    assert r.status_code == 403, f"Expected 403 for non-owner dealer, got {r.status_code}: {r.text[:200]}"


# ---------- regression: submission WITHOUT market_values ----------
@pytest.fixture(scope="module")
def sub_without_market_values(admin_token):
    """Find a submission where market_values is missing or status != 'ok'."""
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = requests.get(f"{API}/admin/submissions", headers=headers, timeout=30)
    assert r.status_code == 200
    subs = r.json().get("submissions") or []
    for s in subs:
        if s.get("reference") == TARGET_REF:
            continue
        mv = s.get("market_values") or {}
        if not mv or mv.get("status") != "ok":
            return s.get("id")
    pytest.skip("No submission without market_values found for regression test")


def test_pdf_without_market_values_still_ok(admin_token, sub_without_market_values):
    headers = {"Authorization": f"Bearer {admin_token}"}
    r = requests.get(
        f"{API}/submissions/{sub_without_market_values}/valuation.pdf",
        headers=headers,
        timeout=60,
    )
    assert r.status_code == 200, f"PDF failed for no-market_values sub: {r.status_code} {r.text[:200]}"
    assert r.content[:5] == b"%PDF-", "Response not a valid PDF"
    text = _extract_pdf_text(r.content)
    # The Kredo section should be absent
    assert "KREDO MARKET VALUES" not in text, "Kredo section should be omitted when status != 'ok'"
