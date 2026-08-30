# TradeAPP — Handover to E3 Agent

> **Goal**: Add a **web-app frontend** to this existing mobile project so dealers and admins can use TradeAPP in a browser at `www.tradeapp.co.za`, while iOS/Android builds continue to serve mobile users. **Do NOT touch the backend or database schema.**

---

## 1. What is TradeAPP?

TradeAPP is a **vehicle-valuation SaaS for South-African dealerships**. Dealers submit vehicles, receive a "cover" (target price) from managerial pricing agents or TradeAPP's AI, mark deal outcomes, transfer sold cars into stock, order VIN-linked history reports (Kredo / Outvin / Bimmervin / MBTools), and are billed monthly for usage.

Live preview: `https://fourbuy-admin.preview.emergentagent.com`

### Roles
| Role | Access |
| --- | --- |
| **Admin** | Everything: revenue, dealerships, catalogs, valuations queue, users |
| **Dealer (regular)** | Submit vehicles, view own submissions, view stock, order VIN reports |
| **Dealer (managerial / `is_pricing_agent`)** | All dealer things + place cover prices, commit dealer offer, mark Deal Done/No Deal, transfer to stock, edit purchase/sold prices |

Test credentials in `/app/memory/test_credentials.md`.

---

## 2. Tech Stack (existing)

| Layer | Tech |
| --- | --- |
| **Backend** | FastAPI (Python 3.11), Motor (async MongoDB) |
| **Database** | MongoDB — collections listed in §5 |
| **Mobile frontend** | Expo Router (React Native + React Native Web) |
| **Auth** | JWT (custom, in `backend/routes/auth.py` — Emergent-managed Google Auth is NOT wired in) |
| **File storage** | Cloudinary (images + PDFs) |
| **AI** | Emergent LLM Key — GPT-5.2 (text), Gemini Nano Banana (image), Sora 2 (video) |
| **Email** | Emergent Managed Resend |
| **Payments** | Manual dealership wallet + monthly invoice scheduler (no Stripe yet) |
| **3rd-party vehicle data** | Kredo (VIN history + CarTrust NaTIS + values), Outvin, Bimmervin, MBTools |

---

## 3. Instructions for E3

### 3.1 Keep the backend and database untouched

- **DO NOT** modify `/app/backend` — leave routes, models, services, scheduler and PDF generation alone
- **DO NOT** modify the MongoDB schema — every collection is production data
- **DO NOT** duplicate authentication logic — reuse `/api/auth/login` and JWT
- Any change to backend behaviour must be requested explicitly

### 3.2 Build a web frontend

The current mobile app already works in a browser via React Native Web, but that preview URL:
- Sleeps after 30 min of inactivity
- Cannot host a custom domain

Build a **real web frontend** — pure React/Next.js/Vite (E3's choice; **recommend Next.js 14 app-router** for SSR + native custom-domain support) that:

1. **Talks to the SAME backend** at `EXPO_PUBLIC_BACKEND_URL` (all endpoints prefixed `/api/...`)
2. **Reuses the SAME JWT** stored in `localStorage` (mobile uses `SecureStore` — web should use `localStorage` or `HttpOnly` cookies)
3. **Uses the same `TradeAppWordmark` visual identity** (see `/app/frontend/src/components/TradeAppWordmark.tsx`) — dark theme, white wordmark on a dark card
4. **Mirrors every mobile screen** — full list in §6
5. **Attaches to `www.tradeapp.co.za`** at deploy time

### 3.3 Where to put the web-app code

Recommended layout in the same repo:

```
/app
├── backend/            # UNCHANGED — FastAPI + Mongo
├── frontend/           # UNCHANGED — Expo mobile app (keeps shipping to App Store / Play Store)
└── web/                # NEW — Next.js 14 web app deployed to www.tradeapp.co.za
    ├── app/            # App-router pages
    ├── components/     # Shared UI (mirror mobile design)
    ├── lib/            # API client, auth helpers, hooks
    ├── public/         # Brand assets
    └── .env
```

### 3.4 API client — reuse mobile conventions

The mobile app's API client is in `/app/frontend/src/api.ts`:
- Base URL from `process.env.EXPO_PUBLIC_BACKEND_URL`
- JWT in `Authorization: Bearer <token>` header
- Auto-refresh on 401 (see `refreshAccessToken` flow)
- Every path is prefixed `/api/...`

Copy the same conventions in the web app. **All 157 backend endpoints are documented under `/api/docs` (FastAPI Swagger) — E3, hit that URL to inspect them.**

---

## 4. Environment / Secrets (existing keys — do NOT change)

All backend secrets already live in `/app/backend/.env`:

| Key | Used for |
| --- | --- |
| `MONGO_URL`, `DB_NAME` | MongoDB — **must be shared with any new job** |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | Auth tokens |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Admin seed on boot |
| `EMERGENT_LLM_KEY` | GPT-5.2, Gemini Nano Banana, Sora 2, Whisper |
| `EMERGENT_PUSH_KEY` | Push notifications (needs `google-services.json` for prod) |
| `EMERGENT_EMAIL_KEY` | Resend email |
| `CLOUDINARY_*` | Image + PDF hosting |
| `KREDO_*`, `BIMMERVIN_*`, `MBTOOLS_*`, `OUTVIN_*`, `TWOCAPTCHA_API_KEY` | Vehicle-report vendors |
| `TURNSTILE_*` | Cloudflare CAPTCHA on public forms |
| `APP_BASE_URL`, `PUBLIC_BASE_URL` | Used in outgoing emails and PDFs |

**⚠️ E3: when you deploy the web app, add `PUBLIC_BASE_URL=https://www.tradeapp.co.za` to the environment** so emailed magic-links and PDF footers point to the right host.

---

## 5. Database Overview (do NOT modify schema)

| Collection | Purpose |
| --- | --- |
| `users` | Dealers + admins. `role`, `is_pricing_agent`, `dealership_id` |
| `dealerships` | Multi-user org. Wallet balance, invoice history, target reset day |
| `submissions` | The core valuation record. `status` in `pending|priced|declined`, plus embedded `deal` (dealer_offer, done, purchase_price, sold_price…), embedded `reports`, `stock_item_id` |
| `stock_items` | Vehicles that have been transferred from submissions |
| `covers` | Cover-price offers made by managerial pricing agents |
| `report_orders` | Billing ledger for VIN reports and admin orders |
| `vin_report_orders` | Standalone (not-tied-to-submission) VIN report orders |
| `invoices` | Monthly usage bills auto-generated by scheduler |
| `wallet_txns` | Deposit / debit ledger per dealership |
| `rewards_ledger` | Loyalty points |
| `makes`, `models`, `derivatives`, `vehicle_specs` | Vehicle catalog |
| `push_tokens` | Expo push registration |
| `ads_queue` | Advertising rotation |
| `suppliers` | Recon suppliers linked to submissions |
| `partner_api_keys` | Reseller API keys (planned) |

---

## 6. Mobile Screens to Mirror on Web

Every route below already exists in `/app/frontend/app/`. E3 should build a matching web page for each.

### Auth (`/app/frontend/app/(auth)/`)
- `login.tsx` — Email + password with TradeAppWordmark hero
- `register.tsx` — Dealer self-signup + dealership picker
- `forgot-password.tsx`, `reset-password.tsx` — Magic-link flow

### Dealer surface (`/app/frontend/app/(app)/`)
- `index.tsx` — **Dealer Portal home** with hero video, tile grid (My Evaluations, Get Cover, Give Cover, Stock, Rewards, Suppliers, VIN Reports), and Live-Last-30-Days stats strip
- `submit.tsx` — Multi-step vehicle submission wizard (Make → Model → Derivative → Year → Mileage → Condition → Photos → NaTIS/registration → optional dealer offer)
- `submissions.tsx` — My Evaluations list with **top-level bucket** (Incoming / Priced / Archived) and **deal-outcome chip** (All / Deal Pending / Deal Done / No Deal). Aug 2026 update: pending submissions can now carry a deal outcome.
- `history.tsx` — Sold-vehicle history
- `vehicle/[id].tsx` — Vehicle detail: PricingCard, DealCard, TransferToStockCard, VinLinkedReportsCard, AdBlurbCard, EditResubmitCard, ownership timeline, PDF download
- `cover.tsx` + `cover/[id].tsx` — Pricing-agent flows to place blind cover offers on other dealers' submissions
- `stock.tsx` — Stock list (2×2 stat grid + list of transferred vehicles + Mark-Sold flow)
- `billing.tsx` — Wallet balance, invoices, statements, deposit modal
- `rewards.tsx` — Points, ranks, redemption
- `suppliers.tsx` — Recon supplier directory + assignment
- `vin-reports/index.tsx` + `vin-reports/new.tsx` — Order + view standalone VIN reports (incl. CarTrust)
- `scan.tsx` — Camera-based VIN scanner (mobile-only — web should offer text input instead)
- `profile.tsx` — Password, notification settings, logout, delete account
- `deal-outcomes.tsx` — Aggregated Deal Done / No Deal report
- `dealers.tsx` — Dealership user directory
- `partner-api.tsx` — Reseller API key (planned)

### Admin (`/app/frontend/app/(app)/`)
- The mobile app currently mixes admin and dealer in `(app)` with role-based gates. The web app can either:
  - Follow the same convention, OR
  - Split into a `/admin` route tree — **recommend the latter for web** so admins land on a dedicated dashboard

**Admin views to build:**
- Revenue dashboard (invoices, monthly income, top dealers)
- Dealership CRUD (create, freeze, wallet top-up, edit)
- Users CRUD (activate `is_pricing_agent` flag)
- Valuations queue (all pending submissions across dealerships)
- Catalogs — makes / models / derivatives / vehicle_specs (from flatfile)
- Cover-price history (all covers ever placed)
- Reports orders (billing ledger)
- Ads queue

### Public
- `/app/frontend/app/get-valuation.tsx` — **Public** valuation request page (Turnstile CAPTCHA-protected, POSTs to `/api/public/valuations`)
- `/app/frontend/app/kredo-api/docs.tsx` — Public partner-API docs

---

## 7. Design System

Reuse these on the web:

- **Wordmark**: `frontend/src/components/TradeAppWordmark.tsx` — pure text "TRADE APP" in a dark rounded card. Rebuild in React for web.
- **Colours** (`frontend/src/theme.ts`):
  - Primary: `#22C55E` (emerald green)
  - Background: `#0B0F14` (deep charcoal)
  - Card: `#111827`
  - Text: `#F9FAFB`
  - Border: `#1F2937`
- **Typography**: System font stack, weights 500/700/800
- **Radius**: `sm: 6, md: 10, lg: 16, pill: 999`
- **Spacing**: 8-pt grid — `xs: 4, sm: 8, md: 16, lg: 24, xl: 32`
- **Icons**: Ionicons (mobile) → use **lucide-react** or **@heroicons/react** on web (matching visual weight)

---

## 8. Non-negotiables

1. **Same backend, same DB** — the web frontend must not read from a different source of truth. Test with the existing admin login (`admin@tradeapp.co.za` / `admin123`) — if the same submissions and dealers appear, you're wired up correctly.
2. **JWT auth reuse** — no re-implementing login; POST to `/api/auth/login`.
3. **Custom domain** — the web build must be deployable at `https://www.tradeapp.co.za`. Add A records `162.159.142.117`, `172.66.2.113` at the apex, CNAME `www` → `tradeapp.co.za`, then Redeploy → Domain → Link Manually.
4. **No mobile-only libraries on web** — swap `expo-camera` → HTML5 file input or manual VIN typing, `expo-video` → `<video>` tag, `expo-secure-store` → `localStorage`, etc.
5. **Never break the mobile app** — if any shared code lives outside `/web`, guard changes with `Platform.OS === "web"` checks.

---

## 9. Migration Checklist for E3's First Session

- [ ] Pull the GitHub repo into the new E3 job
- [ ] Attach the **existing MongoDB** (share `MONGO_URL` / `DB_NAME` from `backend/.env` — ask Emergent support if you can't see them)
- [ ] Copy `backend/.env` values into the new job's Deployment panel
- [ ] Verify backend starts: `sudo supervisorctl status backend` — should be `RUNNING`
- [ ] Verify mobile app still boots at `/` (Expo web preview)
- [ ] Scaffold `/web` — Next.js 14 with app-router, Tailwind, shadcn/ui
- [ ] Build the shared UI kit (Wordmark, Button, Card, Modal, DataTable, StatChip)
- [ ] Implement `/login` → wire to `POST /api/auth/login`
- [ ] Implement `/dashboard` (dealer portal) → GET `/api/submissions/mine`, `/api/dashboards/stats`
- [ ] Iterate through every screen in §6
- [ ] Add admin sub-routes
- [ ] Attach the custom domain
- [ ] Sanity-check side-by-side with the mobile app

---

## 10. Contact

- **Emergent support**: `support@emergent.sh` — quote job ID `fe33bf7d-9d0b-411f-a15c-6aca597a2389`
- **Product owner**: Dave (chat with him in the E3 session)

Good luck 🚗💨
