# Kredo CarTrust callback — activation notes (2026-07-24)

## Status
- Callback endpoint LIVE at `POST /api/kredo/cartrust/callback`
- End-to-end flow VERIFIED with a live order for VIN `SALEA6AW1N2080616` (Land Rover Defender)
  - Order → Kredo ack (client_guid) → callback in ~30 s → PDF (52,181 bytes) stored inline in Mongo → also copied to Cloudinary
  - Authenticated PDF delivery via `GET /api/kredo/cartrust/pdf/{submission_id}`

## Kredo's signing scheme (captured from real callback)
- Header: `X-WZ-Signature` (Whozhoo v2 signer, not `X-Kredo-Signature` as we originally guessed)
- Header: `X-WZ-Timestamp` (epoch seconds)
- Payload includes `hmac`: `{"algo": "HMAC_SHA256", "format": "base64", "timestamp": "...", "signature": "...", "version": "v2"}`
- Reverse-engineered attempts using `KREDO_API_KEY`, `KREDO_PASSWORD`, `KREDO_USERNAME` as secret across common canonical strings (raw body, ts+body, ts.body, body-without-hmac, download_url only, client_guid, etc.) — **no match**.
- Conclusion: Kredo uses a **separate webhook signing secret** we don't yet have.

## What to ask Edward
1. The webhook signing secret (probably called `webhook_secret` or `signing_key`)
2. The canonical string convention — is the signature over:
   - the raw JSON body as-received, or
   - the body minus the `hmac` block, or
   - `timestamp + "." + body` (Slack style), or
   - something else?
3. Signature validity window vs `X-WZ-Timestamp` (do they require ts to be within N minutes?)
4. Retry policy on 5xx / non-200

## Temporary state (safe to leave)
- `KREDO_CARTRUST_SKIP_HMAC=1` in `/app/backend/.env` — bypasses HMAC verification.
- Diagnostic capture of every callback (headers + body) written to `/app/backend/logs/kredo_cartrust_callback.log` — useful for reversing/verifying the signing scheme once Edward provides the secret.

## Once secret arrives
1. Add `KREDO_WEBHOOK_SECRET=<value>` to `/app/backend/.env`
2. Update `_verify_cartrust_signature` to read that secret and construct the canonical string per Edward's spec.
3. Delete/comment `KREDO_CARTRUST_SKIP_HMAC` from `.env`.
4. Restart backend. Trigger one live order. Confirm the callback is verified without bypass.
5. Optionally remove the raw-body diagnostic capture (or leave — it's low noise).

## Stale pending orders
Two older orders were placed *before* Kredo activated the callback URL and were rejected with 401. Kredo's presigned S3 URLs are expired, so those PDFs cannot be recovered without a fresh order:
- Submission `2500341e-9a21-42fa-97c2-30dcbdbd53c9` — VIN `WAUZZZFY1J2198086` (Audi)
- Submission `2d25bdf7-378c-4bdf-9c96-fa3fa89541be` — VIN `WBA42DT0909N56153` (BMW X4 M40i)

If the dealer wants these completed, clear `reports.kredo_cartrust` on those docs and re-order.
