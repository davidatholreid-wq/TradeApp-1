"""Kredo API client — Vehicle Values.

Server-side only. All secrets (API key, username, password) come from
`backend/.env` and never leave the backend. Frontends call our own
`/api/kredo/*` endpoints, which fan out to Kredo.

Auth model
----------
Kredo issues a short-lived (~2h) `authorizationToken` via
`POST /private/client/user/auth` (needs `x-api-key` header and username /
password in the body). Every subsequent call also needs BOTH `x-api-key`
and `authorizationToken` headers.

Kredo uses **single-active-token** semantics: a fresh `/auth` call
invalidates the previous token. This module therefore:

* caches the token in-memory,
* refreshes ~5 minutes before expiry,
* serialises refreshes with an `asyncio.Lock` (so concurrent requests
  don't cause two auths and invalidate each other's tokens),
* on a 401 from a downstream call, force-refreshes exactly once and
  retries the request.

If you ever run more than one backend process, promote the cache to
Mongo — the surface area of the cache is intentionally small so that
swap is easy.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Optional

import httpx

logger = logging.getLogger("kredo")


@dataclass
class _CachedToken:
    token: str
    expires_at: float  # unix seconds
    client_id: Optional[str] = None


class KredoAPIError(Exception):
    """Raised when Kredo returns a non-2xx we can't recover from.

    `upstream_status` / `upstream_body` are surfaced back to the API layer
    so admins can see what actually happened, but we never leak the
    request headers (which contain secrets).
    """

    def __init__(self, message: str, *, upstream_status: int = 0, upstream_body: Any = None):
        super().__init__(message)
        self.upstream_status = upstream_status
        self.upstream_body = upstream_body


class KredoClient:
    """Thin async client for Kredo Vehicle Values.

    Instantiate once at app startup (`kredo = KredoClient(...)`) and reuse
    the same instance — the httpx client and token cache are attached to
    the instance, not to individual requests.
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        username: str,
        password: str,
        refresh_buffer_s: int = 300,
        timeout_s: float = 60.0,
    ):
        if not (base_url and api_key and username and password):
            raise ValueError("Kredo client requires base_url, api_key, username, password")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.username = username
        self.password = password
        self.refresh_buffer_s = refresh_buffer_s
        self._token: Optional[_CachedToken] = None
        self._lock = asyncio.Lock()
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(timeout_s, connect=5.0),
        )

    # ---------- token management ----------

    def _valid(self) -> bool:
        return bool(
            self._token
            and time.time() < (self._token.expires_at - self.refresh_buffer_s)
        )

    async def _authenticate(self) -> _CachedToken:
        """Call Kredo /auth and cache the returned token.

        Kredo returns something like:
            {"status": "success", "authorizationToken": "...",
             "clientId": "...", "tokenExpiry": "..."}

        `tokenExpiry` is documented as an ISO-ish string but we don't fully
        rely on it because parsing it can be inconsistent across
        environments; we defensively assume a 2h TTL from the docs.
        """
        headers = {"x-api-key": self.api_key, "Content-Type": "application/json"}
        try:
            r = await self._http.post(
                "/private/client/user/auth",
                headers=headers,
                json={"username": self.username, "password": self.password},
            )
        except httpx.HTTPError as e:
            logger.exception("kredo_auth_network_error")
            raise KredoAPIError(f"Kredo auth network error: {e}") from e

        if r.is_error:
            logger.error("kredo_auth_failed status=%s body=%s", r.status_code, r.text[:400])
            raise KredoAPIError(
                "Kredo authentication failed",
                upstream_status=r.status_code,
                upstream_body=_safe_body(r),
            )
        data = r.json()
        token = data.get("authorizationToken")
        if not token:
            raise KredoAPIError(
                "Kredo /auth response missing authorizationToken",
                upstream_status=r.status_code,
                upstream_body=data,
            )
        cached = _CachedToken(
            token=token,
            expires_at=time.time() + 2 * 3600,
            client_id=str(data.get("clientId") or "") or None,
        )
        logger.info("kredo_auth_ok client_id=%s expires_in=%ss", cached.client_id, 2 * 3600)
        return cached

    async def _get_token(self, force_refresh: bool = False) -> str:
        if not force_refresh and self._valid():
            return self._token.token  # type: ignore[union-attr]
        async with self._lock:
            # Double-checked: another coroutine may have refreshed while we
            # were waiting on the lock.
            if not force_refresh and self._valid():
                return self._token.token  # type: ignore[union-attr]
            self._token = await self._authenticate()
            return self._token.token

    # ---------- generic call ----------

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        """POST a Kredo endpoint with the current token.

        On 401 we force-refresh and retry once. Everything else surfaces
        as a `KredoAPIError` for the API layer to map to a 502.
        """
        token = await self._get_token()
        headers = {
            "x-api-key": self.api_key,
            "authorizationToken": token,
            "Content-Type": "application/json",
        }
        try:
            r = await self._http.post(path, headers=headers, json=payload)
        except httpx.HTTPError as e:
            logger.exception("kredo_call_network_error path=%s", path)
            raise KredoAPIError(f"Kredo call network error: {e}") from e

        if r.status_code == 401:
            logger.warning("kredo_call_401 path=%s — refreshing token once", path)
            token = await self._get_token(force_refresh=True)
            headers["authorizationToken"] = token
            try:
                r = await self._http.post(path, headers=headers, json=payload)
            except httpx.HTTPError as e:
                logger.exception("kredo_retry_network_error path=%s", path)
                raise KredoAPIError(f"Kredo retry network error: {e}") from e

        if r.is_error:
            logger.error(
                "kredo_call_failed path=%s status=%s body=%s",
                path,
                r.status_code,
                r.text[:400],
            )
            raise KredoAPIError(
                f"Kredo {path} failed",
                upstream_status=r.status_code,
                upstream_body=_safe_body(r),
            )
        try:
            return r.json()
        except ValueError as e:
            raise KredoAPIError(
                f"Kredo {path} returned non-JSON body",
                upstream_status=r.status_code,
                upstream_body=r.text[:500],
            ) from e

    # ---------- vehicle values chain ----------

    @staticmethod
    def _guid() -> str:
        return str(uuid.uuid4())

    async def makes(self) -> dict[str, Any]:
        return await self._post(
            "/public/vehicle_value/valuation/makes",
            {"client_guid": self._guid()},
        )

    async def models(self, make: str) -> dict[str, Any]:
        return await self._post(
            "/public/vehicle_value/valuation/models",
            {"client_guid": self._guid(), "vehicle": {"make": make}},
        )

    async def years(self, make: str, model: str) -> dict[str, Any]:
        return await self._post(
            "/public/vehicle_value/valuation/years",
            {"client_guid": self._guid(), "vehicle": {"make": make, "model": model}},
        )

    async def derivatives(self, make: str, model: str, year: str) -> dict[str, Any]:
        return await self._post(
            "/public/vehicle_value/valuation/derivative",
            {
                "client_guid": self._guid(),
                "vehicle": {"make": make, "model": model, "year": str(year)},
            },
        )

    async def value(
        self,
        *,
        make: str,
        model: str,
        year: str,
        derivative: str,
        mileage: int,
        condition: str,
    ) -> dict[str, Any]:
        return await self._post(
            "/public/vehicle_value/valuation/value",
            {
                "client_guid": self._guid(),
                "vehicle": {
                    "make": make,
                    "model": model,
                    "year": str(year),
                    "derivative": derivative,
                    "mileage": int(mileage),
                    "condition": condition,
                },
            },
        )

    async def vin_history(
        self,
        vin: str,
        *,
        country: str = "za",
        currency: str = "zar",
    ) -> dict[str, Any]:
        """Fetch the accident / claim history for a given VIN.

        Kredo returns a nested structure at `claim-history.result.claim`;
        callers should use `normalise_vin_history()` to flatten it into
        the shape the UI expects.
        """
        return await self._post(
            "/vinhistory",
            {
                "client_guid": self._guid(),
                "vin": vin,
                "country": country,
                "currency": currency,
            },
        )

    async def order_cartrust_pdf(
        self,
        *,
        requester_name: str,
        requester_surname: str,
        requester_email: str,
        requester_phone: str,
        vin: str,
        registration_number: str,
        mileage: int,
        vehicle_condition: str,
        service_history: str = "",
        # Extra vehicle-confirmation fields — Kredo previously received
        # only VIN + Registration + Mileage and echoed everything else
        # as "NOT SUPPLIED" in the Vehicle Confirmation table. Passing
        # the make/model/variant/engine/colour/year we already know
        # from the submission means the returned report shows our data
        # in the "Information Supplied" column and a MATCH/mismatch in
        # "Information Verified". All optional so old callers keep
        # working. Field names duplicated in snake_case + PascalCase
        # variants because Kredo's schema mixes both (e.g. `vin` but
        # `RegistrationNumber`) and we don't have an authoritative
        # spec — sending both is a no-op if the API silently drops
        # unknown keys.
        manufacturer: str = "",
        model: str = "",
        variant: str = "",
        engine_number: str = "",
        colour: str = "",
        year_of_registration: str = "",
    ) -> dict[str, Any]:
        """Order a CarTrust vehicle-history PDF report.

        This is an async operation on Kredo's side — the sync response is
        just an acknowledgement. Kredo will POST to our configured callback
        URL when the PDF is ready, with a 15-min presigned `download_url`
        the server must fetch before it expires.
        """
        payload: dict[str, Any] = {
            "client_guid": self._guid(),
            "requester_name": requester_name,
            "requester_surname": requester_surname,
            "requester_email": requester_email,
            "requester_phone": requester_phone,
            "vin": vin,
            "RegistrationNumber": registration_number,
            "reg": registration_number,  # Kredo's callback echoes this key
            "mileage": str(mileage),
            "vehicle_condition": vehicle_condition,
            "serviceHistory": service_history or "",
        }

        # ---------------------------------------------------------------
        # Brute-force schema discovery for Vehicle Confirmation fields.
        # ---------------------------------------------------------------
        # As of Aug 2026 Kredo's `/public/cartrust_pdf` endpoint silently
        # drops any key it doesn't recognise (verified on FB-000155:
        # only `vin`, `reg`, `mileage`, `vehicle_condition`,
        # `RegistrationNumber` came back in the callback's `user_input`
        # echo — every other key we sent was dropped, and Manufacturer,
        # Engine Number, Colour and Year of Registration all printed
        # "NOT SUPPLIED" on the PDF).
        #
        # Their support has been asked for the authoritative schema.
        # In the meantime we scatter every plausible casing / prefix
        # combination we can think of (snake_case, camelCase, PascalCase,
        # with & without a `vehicle_` prefix, both `colour` and
        # `color`) AND a nested `vehicle: {...}` object — one of these
        # is very likely to match whatever field name their backend
        # actually reads. Unknown keys are silently discarded so this
        # is safe.
        # ---------------------------------------------------------------
        flat_extras: dict[str, str] = {}
        pairs = (
            ("manufacturer", manufacturer),
            ("model",        model),
            ("variant",      variant),
            ("engine_number", engine_number),
            ("colour",       colour),
            ("year_of_registration", year_of_registration),
        )
        for base, val in pairs:
            if not val:
                continue
            camel = "".join(w if i == 0 else w.title() for i, w in enumerate(base.split("_")))
            pascal = "".join(w.title() for w in base.split("_"))
            for variant_key in {
                base,
                base.upper(),
                camel,
                pascal,
                f"vehicle_{base}",
                f"vehicle{pascal}",
                f"car_{base}",
                f"car{pascal}",
            }:
                flat_extras[variant_key] = str(val)

        # Special-cases their doc examples hint at:
        if manufacturer:
            flat_extras.update({"make": manufacturer, "Make": manufacturer, "make_name": manufacturer})
        if engine_number:
            flat_extras.update({
                "engineNumber": engine_number,
                "EngineNo": engine_number,
                "engine_no": engine_number,
            })
        if colour:
            # American spelling might be canonical on their side
            flat_extras.update({
                "color": colour, "Color": colour, "vehicle_color": colour,
                "vehicleColor": colour, "vehicle_colour": colour,
            })
        if year_of_registration:
            flat_extras.update({
                "year": str(year_of_registration),
                "Year": str(year_of_registration),
                "regYear": str(year_of_registration),
                "registrationYear": str(year_of_registration),
                "yearRegistered": str(year_of_registration),
                "year_registered": str(year_of_registration),
            })

        payload.update({k: v for k, v in flat_extras.items() if v})

        # Nested `vehicle` object — REST-conventional shape. Sending this
        # in ADDITION to the flat keys means Kredo can read from either
        # structure without breaking anything.
        vehicle_obj = {
            "make": manufacturer or None,
            "manufacturer": manufacturer or None,
            "model": model or None,
            "variant": variant or None,
            "engineNumber": engine_number or None,
            "engine_number": engine_number or None,
            "colour": colour or None,
            "color": colour or None,
            "year": str(year_of_registration) if year_of_registration else None,
            "yearOfRegistration": str(year_of_registration) if year_of_registration else None,
            "year_of_registration": str(year_of_registration) if year_of_registration else None,
        }
        vehicle_obj = {k: v for k, v in vehicle_obj.items() if v}
        if vehicle_obj:
            payload["vehicle"] = vehicle_obj
            payload["Vehicle"] = vehicle_obj
            payload["vehicle_confirmation"] = vehicle_obj  # long-shot: matches their pdf section name

        # Also mirror everything inside a `user_input` block — because
        # THAT is the key Kredo echoes back on the callback, on the
        # chance they read supplied vehicle info from there too.
        user_input = {
            "vin": vin,
            "reg": registration_number,
            "mileage": str(mileage),
            "vehicle_condition": vehicle_condition,
            "RegistrationNumber": registration_number,
        }
        if manufacturer:
            user_input.update({"manufacturer": manufacturer, "Manufacturer": manufacturer, "make": manufacturer})
        if model:
            user_input["model"] = model
        if variant:
            user_input["variant"] = variant
        if engine_number:
            user_input.update({"engine_number": engine_number, "EngineNumber": engine_number})
        if colour:
            user_input.update({"colour": colour, "color": colour, "Colour": colour})
        if year_of_registration:
            user_input.update({
                "year_of_registration": str(year_of_registration),
                "YearOfRegistration": str(year_of_registration),
                "year": str(year_of_registration),
            })
        payload["user_input"] = user_input

        # Diagnostic log so we can immediately see (in
        # /var/log/supervisor/backend.err.log) what keys we sent to Kredo
        # and cross-check them against Kredo's callback echo.
        logger.info(
            "cartrust_order payload: %d top-level keys; vehicle=%s user_input=%s",
            len(payload),
            list((payload.get("vehicle") or {}).keys()),
            list(user_input.keys()),
        )

        return await self._post("/public/cartrust_pdf", payload)

    async def aclose(self) -> None:
        await self._http.aclose()


def _safe_body(r: httpx.Response) -> Any:
    """Return the JSON body if possible, else the text body, capped."""
    try:
        return r.json()
    except ValueError:
        return r.text[:500]


# ---------- module-level singleton wired from .env ----------

_client: Optional[KredoClient] = None


def get_kredo_client() -> KredoClient:
    """Lazy singleton — created on first use.

    We can't create it at import time because Motor / dotenv may not be
    initialised yet in test environments.
    """
    global _client
    if _client is None:
        _client = KredoClient(
            base_url=os.environ.get("KREDO_BASE_URL", "https://api.kredo.co.za"),
            api_key=os.environ["KREDO_API_KEY"],
            username=os.environ["KREDO_USERNAME"],
            password=os.environ["KREDO_PASSWORD"],
        )
    return _client
