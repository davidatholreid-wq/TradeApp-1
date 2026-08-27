# TradeAPP — Product Requirements (Latest)

## Recent Update — VIN Reports UI & CarTrust Ordering (2026-08-27)
- **Full make catalog** — `/api/vin-reports/makes` now unions `db.makes` (admin-managed catalog, 12 makes including **Suzuki**) with Outvin's supported list and adds Porsche + Ferrari. No more "missing make" gaps.
- **CarTrust orderable from VIN Reports** — Selecting "CarTrust NaTIS History" reveals inline **License Plate + Mileage** inputs. Order returns immediately as `pending`; the existing Kredo webhook fills in the PDF & bills only on success.
- **iOS Safe Area fix** — Make picker header now correctly clears the notch using `useSafeAreaInsets` (native `<Modal>` doesn't inherit the app-level `SafeAreaProvider`, so we apply top padding manually).
- **Robust 4xx validation** — Client errors from CarTrust (missing plate / zero mileage) now propagate as **400** with a clear message instead of being collapsed into a generic 502.

# TradeAPP — PRD

## Latest Change: Fourbuy → TradeAPP Full Rebrand (Feb 2027)
- **New AI-generated wordmark logo** — matching the previous "TRADE" + rounded-square lockup style with "APP" replacing "AI", auto-cropped to a tight 965×392 landscape ratio so it reads clearly at every callsite.
- **345 replacements across 49 production source files** — server.py, all routes, all frontend screens, PDFs, emails.
- **Reference codes**: `FB-` preserved for historical records; new submissions get `TA-` (shared counter — no numbering gap).
- **Platform emails**: all `@fourbuy.co.za` renamed to `@tradeapp.co.za`.
- **Admin display name**: "Fourbuy Admin" → "TradeAPP Admin".
- **App display name**: `app.json` name = `TradeAPP`.
- **Customer dealership names preserved as-is** — "Fourbuy Fourways Gardens" and any other dealership names remain untouched because they are the dealers' own brands, not the platform's.
- **PDF generation**: uses the new logo asset; every user-visible watermark, header band, footer, author metadata, and email template says TradeAPP.

## Login credentials
- Admin: `admin@tradeapp.co.za` / `admin123`
- Dealer (Dave / Fourbuy Fourways Gardens): `dave@tradeapp.co.za` / `Dave1234!`

## Core Modules
- Vehicle valuation submissions (R50 charge on submission)
- Admin cockpit + Pricing Agents (Managerial)
- Billing & Finance (auto-invoicing scheduler, arrears toggle, strict payment allocation)
- VIN-Linked Reports (BMW Factory Options, Kredo VIN, Kredo CarTrust with NaTIS + Owner Timeline drilldown)
- AI Insights: Tyre estimator · GPT-5.2 recall checks · Advertising Blurb generator
- Debtors report & PDF streams
- Stock List — modern 2×2 summary grid, aging chart, spreadsheet-style unit table with row-level ad shortcut
