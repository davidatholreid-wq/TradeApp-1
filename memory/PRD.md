# TRADE AI powered by FOURBUY — PRD

## Latest Change
- **Stock List redesign (Feb 2027)** — Removed floorplan tile + column + inline editor entirely. Summary now renders as a modern 2×2 grid of big glanceable tiles: Units in stock, Capital tied up, Expected GP (colour-coded), Average age.
- **Advertising Blurb generator (Feb 2027)** — New GPT-5.2 endpoint `POST /api/submissions/{id}/ad-blurb` produces three channel-tuned marketing blurbs: Facebook Marketplace, AutoTrader Listing, WhatsApp broadcast. Uses full vehicle context (options, warranty, service plan, ownership, target sell price). Result is cached; `?refresh=1` regenerates.
- New `AdBlurbCard` collapsible card on vehicle detail with channel tabs, Copy button, native Share on iOS/Android.
- Stock List row has a purple megaphone icon that deep-links to `?openAdBlurb=1` — auto-expands + auto-generates on the vehicle detail page.

## Core Modules
- Vehicle valuation submissions (R50 charge on submission)
- Admin cockpit + Pricing Agents (Managerial)
- Billing & Finance (auto-invoicing scheduler, arrears toggle, strict payment allocation)
- VIN-Linked Reports (BMW Factory Options, Kredo VIN, Kredo CarTrust with NaTIS + owner peek)
- AI Insights: Tyre estimator · GPT-5.2 recall checks · **Advertising Blurb generator**
- Debtors report & PDF streams
- **Stock List** — modern 2×2 summary grid, aging chart, spreadsheet-style unit table with row-level ad shortcut
