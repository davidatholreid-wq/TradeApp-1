# TradeAPP — PRD

## Latest Change: Fourbuy → TradeAPP Full Rebrand (Feb 2027)
- **New AI-generated wordmark logo** — matching the previous "TRADE" + rounded-square lockup style with "APP" replacing "AI", auto-cropped to a tight 965×392 landscape ratio so it reads clearly at every callsite (header chip, tab bar, PDF stamp, hero panel).
- **345 replacements across 49 production source files** — server.py, all routes/*, all cover, billing, auth, partner_api, kredo modules; every frontend screen; PDFs; emails. See `backend/scripts/rebrand_fourbuy_to_tradeapp.py`.
- **Reference codes**: `FB-` preserved for historical records; new submissions get `TA-` (shared counter — no numbering gap).
- **Emails**: all `@fourbuy.co.za` renamed to `@tradeapp.co.za` in code, .env, DB (users + 48 submission snapshots).
- **Dealership name**: "Fourbuy Fourways Gardens (PTY) Ltd" → "TradeAPP Fourways Gardens (PTY) Ltd" (also updated the 48 submission `company_name` snapshots).
- **Admin display name**: "Fourbuy Admin" → "TradeAPP Admin".
- **App display name**: `app.json` name changed to `TradeAPP`.
- **PDF generation**: Uses the new logo asset at `/app/frontend/assets/images/logo-tradeapp.png`; every user-visible watermark, header band, footer, author metadata, and email template says TradeAPP.
- **Login hero background**: Switched from Fourbuy CDN URL to a local `hero_poster.jpg` asset so the login screen never depends on the legacy CDN.
- **Storage keys / logger names**: intentionally kept as `fourbuy.themeMode`, `fourbuy.billing`, etc. (technical identifiers, not user-visible) — avoids resetting dealer theme prefs and breaking log dashboards.
- **Cloudinary folders**: `fourbuy/submissions/…` intentionally kept for object-storage backwards compatibility with existing images.

## Core Modules
- Vehicle valuation submissions (R50 charge on submission)
- Admin cockpit + Pricing Agents (Managerial)
- Billing & Finance (auto-invoicing scheduler, arrears toggle, strict payment allocation)
- VIN-Linked Reports (BMW Factory Options, Kredo VIN, Kredo CarTrust with NaTIS + Owner Timeline drilldown)
- AI Insights: Tyre estimator · GPT-5.2 recall checks · Advertising Blurb generator
- Debtors report & PDF streams
- Stock List — modern 2×2 summary grid, aging chart, spreadsheet-style unit table with row-level ad shortcut
