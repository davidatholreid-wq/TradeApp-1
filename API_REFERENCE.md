# TradeAPP — API Reference for E3

> Auto-generated from route decorators. All paths are relative — prepend `/api` to every path (the FastAPI app mounts the router at `/api`). Interactive Swagger UI is available at `<backend_url>/api/docs`.

## Legend
- 🔓 = Public (no auth)
- 🔑 = Dealer JWT required
- 👑 = Admin JWT required
- 💼 = Managerial dealer (`is_pricing_agent = true`) required

---

## Auth
| Method | Path | Auth |
| --- | --- | --- |
| POST | `/api/auth/register` | 🔓 |
| POST | `/api/auth/login` | 🔓 |
| POST | `/api/auth/forgot-password` | 🔓 |
| POST | `/api/auth/reset-password` | 🔓 |
| GET | `/api/auth/me` | 🔑 |
| PATCH | `/api/auth/me` | 🔑 |
| DELETE | `/api/auth/me` | 🔑 |
| GET | `/api/referral/lookup` | 🔓 |
| GET | `/api/agreement/status` | 🔑 |
| POST | `/api/agreement/accept` | 🔑 |

## Push / Notifications
| Method | Path | Auth |
| --- | --- | --- |
| POST | `/api/register-push` | 🔑 |
| GET | `/api/notifications/preferences` | 🔑 |
| PUT | `/api/notifications/preferences` | 🔑 |

## Vehicle Catalog
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/vehicles/makes` | 🔑 |
| GET | `/api/vehicles/models` | 🔑 |
| GET | `/api/vehicles/derivatives` | 🔑 |
| GET | `/api/vehicles/options` | 🔑 |
| POST | `/api/vehicles/license-disk/decode` | 🔑 |
| GET | `/api/admin/makes-catalogue` | 👑 |
| PATCH | `/api/admin/makes-catalogue` | 👑 |

## Submissions (dealer's own valuations)
| Method | Path | Auth |
| --- | --- | --- |
| POST | `/api/submissions` | 🔑 |
| POST | `/api/submissions/{sub_id}/resubmit` | 🔑 |
| GET | `/api/submissions/my` | 🔑 |
| GET | `/api/submissions/{sub_id}` | 🔑 |
| GET | `/api/history` | 🔑 |
| GET | `/api/drafts` | 🔑 |
| POST | `/api/drafts` | 🔑 |
| GET | `/api/drafts/{draft_id}` | 🔑 |
| DELETE | `/api/drafts/{draft_id}` | 🔑 |
| POST | `/api/submissions/{sub_id}/market-values/refresh` | 🔑 |
| PATCH | `/api/submissions/{sub_id}/deal` | 💼 |
| PATCH | `/api/submissions/{sub_id}/license-disk` | 🔑 |

## Submission PDFs & AI
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/submissions/{sub_id}/valuation.pdf` | 🔑 |
| GET | `/api/submissions/{sub_id}/reconditioning.pdf` | 🔑 |
| GET | `/api/submissions/{sub_id}/profit-analysis.pdf` | 🔑 |
| GET | `/api/submissions/{sub_id}/reports/{report_type}.pdf` | 🔑 |
| POST | `/api/submissions/{sub_id}/market-analysis` | 🔑 |
| POST | `/api/submissions/{sub_id}/tyre-estimate` | 🔑 |
| POST | `/api/submissions/{sub_id}/vehicle-insights` | 🔑 |
| POST | `/api/submissions/{sub_id}/ad-blurb` | 🔑 |

## Cover / Pricing
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/cover/submissions` | 💼 |
| GET | `/api/cover/declined-submissions` | 💼 |
| GET | `/api/cover/submissions/{sub_id}` | 💼 |
| POST | `/api/cover/submissions/{sub_id}/decline` | 💼 |
| DELETE | `/api/cover/submissions/{sub_id}/decline` | 💼 |
| POST | `/api/submissions/{sub_id}/covers` | 💼 |
| GET | `/api/submissions/{sub_id}/covers` | 🔑 |
| PATCH | `/api/admin/users/{user_id}/pricing-agent` | 👑 |

## Admin — Submissions
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/admin/submissions` | 👑 |
| GET | `/api/admin/submissions/counts` | 👑 |
| POST | `/api/admin/submissions/{sub_id}/price` | 👑 |
| POST | `/api/admin/submissions/{sub_id}/decline` | 👑 |
| POST | `/api/admin/submissions/{sub_id}/bimmer-spec` | 👑 |
| GET | `/api/admin/submissions/{sub_id}/vin-history` | 👑 |
| DELETE | `/api/admin/submissions/{sub_id}` | 👑 |
| POST | `/api/admin/vehicle-specs/upload-flatfile` | 👑 |
| POST | `/api/admin/vehicle-specs/reseed` | 👑 |

## Reports Catalog (per-submission)
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/reports/catalog` | 🔑 |
| GET | `/api/submissions/{sub_id}/reports` | 🔑 |
| POST | `/api/submissions/{sub_id}/reports` | 🔑 |

## Standalone VIN Reports
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/vin-reports/makes` | 🔑 |
| GET | `/api/vin-reports/available` | 🔑 |
| POST | `/api/vin-reports/order` | 🔑 |
| GET | `/api/vin-reports/mine` | 🔑 |
| GET | `/api/vin-reports/{order_id}` | 🔑 |
| GET | `/api/vin-reports/{order_id}/pdf` | 🔑 |

## Kredo (vehicle values + CarTrust NaTIS)
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/kredo/makes` | 🔑 |
| GET | `/api/kredo/models` | 🔑 |
| GET | `/api/kredo/years` | 🔑 |
| GET | `/api/kredo/derivatives` | 🔑 |
| POST | `/api/kredo/value` | 🔑 |
| POST | `/api/kredo/vin-history` | 🔑 |
| POST | `/api/kredo/cartrust/order` | 🔑 |
| GET | `/api/kredo/cartrust/status/{submission_id}` | 🔑 |
| GET | `/api/kredo/cartrust/pdf/{submission_id}` | 🔑 |
| POST | `/api/kredo/cartrust/callback` | 🔓 (HMAC-verified webhook from Kredo) |

## Stock
| Method | Path | Auth |
| --- | --- | --- |
| POST | `/api/submissions/{sid}/transfer-to-stock` | 💼 |
| POST | `/api/submissions/{sid}/untransfer-from-stock` | 💼 |
| GET | `/api/stock` | 🔑 |
| PATCH | `/api/stock/{sid}` | 💼 |
| POST | `/api/stock/{sid}/mark-sold` | 💼 |
| GET | `/api/stock/export.csv` | 🔑 |

## Suppliers (Recon)
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/suppliers` | 🔑 |
| POST | `/api/suppliers` | 💼 |
| PUT | `/api/suppliers/{sid}` | 💼 |
| DELETE | `/api/suppliers/{sid}` | 💼 |
| POST | `/api/submissions/{sub_id}/reconditioning/{index}/supplier` | 💼 |

## Dealerships (own + admin)
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/my-dealership` | 🔑 |
| PATCH | `/api/my-dealership` | 💼 |
| GET | `/api/my-dealership/invoice-details.pdf` | 🔑 |
| GET | `/api/admin/dealerships` | 👑 |
| POST | `/api/admin/dealerships` | 👑 |
| GET | `/api/admin/dealerships/{dealership_id}` | 👑 |
| PATCH | `/api/admin/dealerships/{dealership_id}` | 👑 |
| POST | `/api/admin/dealerships/{dealership_id}/users` | 👑 |

## Admin — Users (Dealers)
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/admin/dealers` | 👑 |
| GET | `/api/admin/dealers/{dealer_id}` | 👑 |
| PATCH | `/api/admin/dealers/{dealer_id}` | 👑 |
| POST | `/api/admin/dealers/{dealer_id}/password` | 👑 |
| POST | `/api/admin/dealers/{dealer_id}/active` | 👑 |
| POST | `/api/admin/dealers/{dealer_id}/photos` | 👑 |
| POST | `/api/admin/dealers/{dealer_id}/archive` | 👑 |
| POST | `/api/admin/dealers/{dealer_id}/restore` | 👑 |
| DELETE | `/api/admin/dealers/{dealer_id}` | 👑 |

## Billing (dealer)
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/billing/my` | 🔑 |
| GET | `/api/billing/my-summary` | 🔑 |
| GET | `/api/billing/my-invoice/{invoice_id}.pdf` | 🔑 |

## Billing (admin)
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/admin/billing` | 👑 |
| GET | `/api/admin/billing/overview` | 👑 |
| GET | `/api/admin/billing/debtors-report.pdf` | 👑 |
| POST | `/api/admin/billing/run-monthly-batch` | 👑 |
| GET | `/api/admin/dealerships/{dealership_id}/billing-summary` | 👑 |
| PATCH | `/api/admin/dealerships/{dealership_id}/billing-terms` | 👑 |
| POST | `/api/admin/dealerships/{dealership_id}/payments` | 👑 |
| POST | `/api/admin/dealerships/{dealership_id}/deposit-refund` | 👑 |
| POST | `/api/admin/dealerships/{dealership_id}/invoices/generate` | 👑 |
| POST | `/api/admin/dealerships/{dealership_id}/invoices/{invoice_id}/resend-email` | 👑 |
| GET | `/api/admin/dealerships/{dealership_id}/invoices/{invoice_id}.pdf` | 👑 |
| GET | `/api/admin/dealerships/{dealership_id}/statement.pdf` | 👑 |
| GET | `/api/admin/company-settings` | 👑 |
| PUT | `/api/admin/company-settings` | 👑 |

## Rewards
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/rewards/me` | 🔑 |
| POST | `/api/rewards/redeem` | 🔑 |
| GET | `/api/admin/reward-redemptions` | 👑 |
| POST | `/api/admin/reward-redemptions/{redemption_id}/fulfill` | 👑 |
| POST | `/api/admin/reward-redemptions/{redemption_id}/reject` | 👑 |
| GET | `/api/admin/rewards/leaderboard` | 👑 |
| GET | `/api/admin/rewards/users` | 👑 |
| POST | `/api/admin/rewards/grant` | 👑 |

## Ads
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/ads/active` | 🔑 |
| GET | `/api/admin/ads` | 👑 |
| GET | `/api/admin/ads/{slot_number}` | 👑 |
| PUT | `/api/admin/ads/{slot_number}` | 👑 |
| DELETE | `/api/admin/ads/{slot_number}` | 👑 |

## Stats & Dashboards
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/stats/covers-30d` | 🔑 |
| GET | `/api/stats/deal-outcomes` | 🔑 |
| GET | `/api/stats/deal-outcomes/list` | 🔑 |
| GET | `/api/admin/stats/deal-outcomes-by-dealer` | 👑 |
| GET | `/api/admin/stats/home-mtd` | 👑 |

## Public (no auth — Turnstile CAPTCHA-protected)
| Method | Path | Auth |
| --- | --- | --- |
| POST | `/api/public/license-disk/decode` | 🔓 |
| POST | `/api/public/valuation` | 🔓 |
| GET | `/api/public/valuation/{reference}/pdf` | 🔓 |
| GET | `/api/admin/public-submissions` | 👑 |
| GET | `/api/admin/public-submissions/{sub_id}` | 👑 |
| POST | `/api/admin/public-submissions/{sub_id}/price` | 👑 |
| POST | `/api/admin/public-submissions/{sub_id}/market-values` | 👑 |
| POST | `/api/admin/public-submissions/{sub_id}/deliver` | 👑 |
| DELETE | `/api/admin/public-submissions/{sub_id}` | 👑 |
| POST | `/api/admin/public-submissions/{sub_id}/restore` | 👑 |

## Partner / Reseller API (external clients)
| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/partner/v1/health` | 🔑 X-API-Key |
| GET | `/api/partner/v1/vin-lookup/{vin}` | 🔑 X-API-Key |
| GET | `/api/partner/v1/usage/current-month` | 🔑 X-API-Key |
| GET | `/api/partner-api/docs.pdf` | 🔓 |
| GET | `/api/admin/partner-clients` | 👑 |
| POST | `/api/admin/partner-clients` | 👑 |
| PATCH | `/api/admin/partner-clients/{client_id}` | 👑 |
| POST | `/api/admin/partner-clients/{client_id}/rotate-key` | 👑 |
| POST | `/api/admin/partner-clients/{client_id}/revoke` | 👑 |
| GET | `/api/admin/partner-clients/{client_id}/usage` | 👑 |

---

**Total: 157 endpoints across 12 modules.** All discoverable at `/api/docs`.
