# TradeAPP

A vehicle-valuation SaaS for South-African dealerships. Dealers submit vehicles, managerial pricing agents place cover offers, and the platform tracks deals, stock, VIN reports, billing and rewards end-to-end.

Live preview: <https://fourbuy-admin.preview.emergentagent.com>

---

## Repo layout

```
/app
├── backend/     # FastAPI + Motor (async MongoDB) — 157 endpoints
├── frontend/    # Expo Router (React Native + React Native Web)
├── memory/      # PRD, test credentials, session notes
├── scripts/     # Ops utilities
├── media_kit/   # Marketing assets + ad script
└── docs (top-level markdown files)
    ├── README.md              # ← you are here
    ├── HANDOVER_TO_E3.md      # 👉 START HERE if you're the E3 agent
    └── API_REFERENCE.md       # All 157 endpoints, grouped, with auth
```

## Tech Stack

| Layer | Tech |
| --- | --- |
| Backend | FastAPI · Motor · MongoDB |
| Mobile | Expo Router · React Native (+ Web) |
| Auth | JWT (custom) |
| AI | Emergent LLM Key — GPT-5.2, Gemini Nano Banana, Sora 2 |
| Files | Cloudinary |
| Email | Emergent Managed Resend |
| Vehicle data | Kredo · Outvin · Bimmervin · MBTools |

## Running locally

Everything is managed by Emergent's Supervisor. To restart:

```bash
sudo supervisorctl restart backend   # FastAPI on :8001, routed via /api
sudo supervisorctl restart expo      # Metro dev server on :3000
```

Env vars live in `/app/backend/.env` and `/app/frontend/.env`. **Never** modify `MONGO_URL`, `EXPO_PACKAGER_PROXY_URL`, or `EXPO_PACKAGER_HOSTNAME`.

## Test credentials

See `/app/memory/test_credentials.md`. Short version:

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@tradeapp.co.za` | `admin123` |
| Managerial dealer | `dave@tradeapp.co.za` | `Dave1234!` |
| Regular dealer | `minitest@example.com` | `password` |

## Roadmap

Planned next (from PRD, `/app/memory/PRD.md`):
- Add a **web app frontend** for dealers/admins → attach `www.tradeapp.co.za`
- Deal Tracking & Profit Analysis dashboard
- Recon Supplier & Stock Ageing view
- Reseller Partner API v1 → GA

## For the E3 agent

If you were just pulled into this repo, read **`HANDOVER_TO_E3.md`** first — it explains what to build, what NOT to touch, and gives you a screen-by-screen shopping list plus an API reference.
