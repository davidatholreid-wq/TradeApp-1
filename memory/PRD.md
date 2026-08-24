# TRADE AI powered by FOURBUY — PRD

## Latest Change
- **Owner Timeline Drilldown (Feb 2027)** — Tapping the green "N owners" chip on the Kredo CarTrust card now opens a full ownership timeline modal. Vertical timeline with a colour-coded dot per row (green = current, indigo = previous), owner name (e.g. "FOURBUY WHOLESALE (PTY) LTD"), CURRENT / PREVIOUS pill, and the ownership date formatted as "14 Apr 2026".
- Backend PDF scraper now extracts the full per-owner timeline (`name`, `kind`, `date_iso`) from Kredo's CarTrust PDF and stores it under `reports.kredo_cartrust.ownership_summary.timeline`.
- Callback, status-check, and legacy backfill paths all merge the timeline in when it's missing — legacy reports auto-populate on the next open.

## Core Modules
- Vehicle valuation submissions (R50 charge on submission)
- Admin cockpit + Pricing Agents (Managerial)
- Billing & Finance (auto-invoicing scheduler, arrears toggle, strict payment allocation)
- VIN-Linked Reports (BMW Factory Options, Kredo VIN, Kredo CarTrust with NaTIS + **Owner Timeline drilldown**)
- AI Insights: Tyre estimator · GPT-5.2 recall checks · Advertising Blurb generator
- Debtors report & PDF streams
- Stock List — modern 2×2 summary grid, aging chart, spreadsheet-style unit table with row-level ad shortcut
