# AutoPricePro — Product Requirements

## Overview
Mobile app for South African car dealers/traders to submit vehicle information to a central admin for pricing. Solves the problem of missed WhatsApp pricing requests.

## Roles
1. **Dealer** — self-registers with personal + company info, submits vehicles.
2. **Admin** — seeded (`admin@autopricepro.com` / `admin123`); reviews submissions, offers prices, and manages dealers.

## Core Features
- **JWT auth** — bcrypt password hashing, `/api/auth/register`, `/api/auth/login`, `/api/auth/me`.
- **Cascading vehicle DB** (seeded flat list): Make → Model → Derivative. Endpoints: `/api/vehicles/makes`, `/api/vehicles/models?make_id=`, `/api/vehicles/derivatives?model_id=`.
- **Vehicle submission**: mileage, year, factory warranty toggle, condition (1-10 slider), accident damage toggle, colour, license disk barcode scan (optional), 5 required photos (front, right, rear, left, interior — base64 up to ~500KB each).
- **Dealer view**: list own submissions with status (pending/priced) + offered price when returned.
- **Admin view**: list all submissions + offer price via bottom sheet with optional notes.
- **Admin dealer management**: list dealers with submission count, remove dealer (also deletes their submissions).
- **Push notifications**: Emergent-managed. When admin sets a price, dealer receives push. Requires deployed build (does not work in Expo Go). `google-services.json` needed for Android.

## Tech
- Backend: FastAPI + Motor (MongoDB), PyJWT, bcrypt, httpx (for Emergent push relay).
- Frontend: Expo 54 + expo-router, expo-camera (barcode PDF417), expo-image-picker, expo-notifications, react-native-safe-area-context.

## Design system
Dark "Performance Pro" theme (see `/app/design_guidelines.json`). Primary blue `#007AFF`, danger `#FF3B30`, success `#34C759`, warning `#FF9F0A`. Pill CTAs, cards with 1px border, mono font for prices/VIN.

## Not yet built (future)
- External vehicle DB API integration (currently seeded local list).
- License disk PDF417 parsing (currently stores raw scanned string; can be parsed later).
- Web-only admin panel (admin uses same mobile app for now).
- Refresh tokens.

## Third-Party Integrations (delivered)
- **Kredo** — CarTrust vehicle report + VIN accident history (live paid API).
- **Bimmervin (vinrequest.xyz)** — BMW / MINI factory options (OAuth2 client-credentials, live paid API).
- **mbtools.com (mb.vin operator)** — Mercedes-family factory options / SA codes (single `apiKey` query-string, live paid API). Added Jan 2026. Same JWT auth family as Bimmervin.
- **Cloudinary** — image storage for license disks & vehicle photos.
- **Cloudflare Turnstile** — public valuation portal captcha.
- **Emergent** — LLM (GPT-5.2), Resend Email, Push Notifications.
