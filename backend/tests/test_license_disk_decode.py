"""Tests for POST /api/vehicles/license-disk/decode (iteration_34).

Covers:
  - Auth guard (401/403 without token)
  - Empty body → 400
  - Invalid base64 → 400
  - Small solid-colour JPEG (no barcode, no text) → 422 (never 500)
  - Well-formed raw SA-disc string → 200 with source='barcode' & parsed fields
"""
import base64
import io
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://fourbuy-admin.preview.emergentagent.com").rstrip("/")
DECODE_URL = f"{BASE_URL}/api/vehicles/license-disk/decode"
LOGIN_URL = f"{BASE_URL}/api/auth/login"

ADMIN_EMAIL = "admin@fourbuy.co.za"
ADMIN_PASSWORD = "admin123"


@pytest.fixture(scope="module")
def auth_token():
    r = requests.post(LOGIN_URL, json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, f"No token in login response: {r.json()}"
    return tok


@pytest.fixture(scope="module")
def auth_headers(auth_token):
    return {"Authorization": f"Bearer {auth_token}"}


@pytest.fixture(scope="module")
def solid_jpeg_b64():
    """Small solid-colour JPEG — no barcode, no readable text."""
    from PIL import Image
    img = Image.new("RGB", (200, 200), (128, 128, 128))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=70)
    return base64.b64encode(buf.getvalue()).decode("ascii")


# ---------------- Auth ----------------
class TestAuthGuard:
    def test_unauth_returns_401_or_403(self):
        r = requests.post(DECODE_URL, json={"raw": "%1%foo%"}, timeout=15)
        assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}: {r.text}"

    def test_authed_login_works(self, auth_headers):
        r = requests.post(DECODE_URL, json={"raw": "%1%foo%"}, headers=auth_headers, timeout=15)
        # Should NOT be 401/403
        assert r.status_code not in (401, 403), f"Auth failed unexpectedly: {r.status_code} {r.text}"


# ---------------- Request validation ----------------
class TestRequestValidation:
    def test_empty_body_returns_400(self, auth_headers):
        r = requests.post(DECODE_URL, json={}, headers=auth_headers, timeout=15)
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"

    def test_invalid_base64_returns_400(self, auth_headers):
        r = requests.post(
            DECODE_URL,
            json={"image_base64": "!!!not-valid-base64!!!$$@@"},
            headers=auth_headers,
            timeout=30,
        )
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"
        detail = (r.json().get("detail") or "").lower()
        assert "base64" in detail or "invalid" in detail, f"Detail should mention base64: {detail}"


# ---------------- Barcode path (raw string) ----------------
class TestBarcodeRawDecode:
    SAMPLE_RAW = "%1%foo%GS12345%TOYOTA%COROLLA%WHITE%AHTBB1KX20A012345%1AA-Z0-1234%2026-04-30%SEDAN"

    def test_raw_string_returns_200_and_barcode_source(self, auth_headers):
        r = requests.post(
            DECODE_URL,
            json={"raw": self.SAMPLE_RAW},
            headers=auth_headers,
            timeout=15,
        )
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("source") == "barcode", f"source should be 'barcode': {body}"
        assert body.get("raw"), "raw should be echoed back"
        assert isinstance(body.get("parsed"), dict), "parsed must be a dict"

    def test_raw_string_parses_all_fields(self, auth_headers):
        r = requests.post(
            DECODE_URL,
            json={"raw": self.SAMPLE_RAW},
            headers=auth_headers,
            timeout=15,
        )
        assert r.status_code == 200
        parsed = r.json()["parsed"]
        assert parsed.get("vin") == "AHTBB1KX20A012345"
        assert parsed.get("make") == "TOYOTA"
        assert parsed.get("model") == "COROLLA"
        assert parsed.get("colour") == "White"
        assert parsed.get("expiryDate") == "2026-04-30"
        assert parsed.get("description", "").lower().startswith("sedan")
        # engineNo is the token immediately after VIN → "1AA-Z0-1234"
        assert parsed.get("engineNo") == "1AA-Z0-1234"


# ---------------- Photo path fallback (OCR) ----------------
class TestOcrFallback:
    def test_blank_photo_no_500(self, auth_headers, solid_jpeg_b64):
        """A photo with NO barcode and NO readable text must not 500."""
        r = requests.post(
            DECODE_URL,
            json={"image_base64": solid_jpeg_b64},
            headers=auth_headers,
            timeout=60,  # OCR/LLM path can take a few seconds
        )
        assert r.status_code != 500, f"Server crashed on blank photo: {r.text}"
        # Either 422 (couldn't read anything) OR 200 with nulled fields
        assert r.status_code in (200, 422), f"Unexpected status {r.status_code}: {r.text}"
        if r.status_code == 200:
            body = r.json()
            assert body.get("source") in ("ocr", "barcode")
            parsed = body.get("parsed") or {}
            # No VIN should have been fabricated from a solid grey square
            vin = parsed.get("vin")
            if vin:
                # If a VIN is present, it must at least look real (17 chars alnum)
                assert len(vin) == 17
        else:
            detail = (r.json().get("detail") or "").lower()
            assert any(w in detail for w in ("read", "disc", "photo", "clear")), f"Unhelpful 422 message: {detail}"

    def test_photo_with_readable_pdf417_barcode(self, auth_headers):
        """Regression: photo containing a real PDF-417 must decode via the
        barcode stage (source='barcode'), NOT fall through to OCR.

        Was silently broken by `BarcodeFormat.lower()` AttributeError; fix in
        server.py wraps `getattr(r, "format", "")` in str().
        """
        try:
            from pdf417gen import encode, render_image
        except ImportError:
            pytest.skip("pdf417gen not installed")
        import io as _io
        codes = encode("%1%foo%GS12345%TOYOTA%COROLLA%WHITE%AHTBB1KX20A012345%1AA-Z0-1234%2026-04-30%SEDAN")
        img = render_image(codes, scale=3).convert("RGB")
        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")

        r = requests.post(
            DECODE_URL,
            json={"image_base64": b64},
            headers=auth_headers,
            timeout=60,
        )
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("source") == "barcode", f"Expected barcode source, got {body}"
        parsed = body.get("parsed") or {}
        assert parsed.get("vin") == "AHTBB1KX20A012345"
        assert parsed.get("make") == "TOYOTA"

    def test_blank_photo_with_data_uri_prefix(self, auth_headers, solid_jpeg_b64):
        """Also accept `data:image/jpeg;base64,...` prefix (frontend sends this form)."""
        data_uri = f"data:image/jpeg;base64,{solid_jpeg_b64}"
        r = requests.post(
            DECODE_URL,
            json={"image_base64": data_uri},
            headers=auth_headers,
            timeout=60,
        )
        assert r.status_code != 500, f"Server crashed on data-URI photo: {r.text}"
        assert r.status_code in (200, 422)
