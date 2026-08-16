// -----------------------------------------------------------------------------
// Vehicle domain types — extracted from `/app/frontend/app/(app)/vehicle/[id].tsx`
// during the P1 modularization pass (Aug 2026).
//
// Kept as pure TS type declarations so this module has ZERO runtime cost
// and can be safely imported from anywhere (route screens, modal
// components, admin cockpit widgets) without dragging React or
// react-native into the bundle graph.
//
// If you're editing a type here, remember to also update:
//   • The Kredo response mappers in `/app/backend/routes/kredo.py`
//   • The submission serializer in `/app/backend/server.py`
//   • Any admin cockpit widget that consumes `Submission` (there are
//     a few in `/app/frontend/src/components/`).
// -----------------------------------------------------------------------------

/** A single line item in the "reconditioning bill" a dealer builds up
 *  for a vehicle. Supports both the legacy free-text label + single
 *  photo shape (older submissions) and the current category +
 *  multi-photo shape. */
export type ReconItem = {
  label: string;
  category?: string | null;
  amount_zar: number;
  photo?: string | null;
  photos?: string[];
};

/** Dealer-only deal outcome tracking. Stage 1 (purchase) unlocks Stage
 *  2 (sale). All fields remain editable per user request; timestamps
 *  are stamped by the backend the first time each stage flips to
 *  `true`. */
export type DealInfo = {
  done?: boolean | null;
  purchased_at?: string | null;
  purchase_price_zar?: number | null;
  sold?: boolean | null;
  sold_at?: string | null;
  recon_cost_zar?: number | null;
  sale_price_zar?: number | null;
  /** Dealer's own pre-purchase offer to the seller. Gates the rest of
   *  the Deal Tracking flow — until set, Stage 1 / Stage 2 are
   *  hidden. */
  dealer_offer_zar?: number | null;
  dealer_offer_at?: string | null;
  updated_at?: string | null;
  updated_by_name?: string | null;
};

export type DealProfit = {
  dealer_offer_zar?: number | null;
  purchase_price_zar: number | null;
  recon_cost_zar: number | null;
  sale_price_zar: number | null;
  cost_basis_zar: number | null;
  profit_zar: number | null;
  margin_pct: number | null;
};

export type PriceHistoryEntry = {
  id: string;
  action: "offer" | "update";
  previous_price: number | null;
  new_price: number;
  previous_notes: string | null;
  new_notes: string | null;
  comment: string;
  admin_id: string;
  admin_name: string;
  at: string;
};

export type ReportOrder = {
  id: string;
  submission_id: string;
  type:
    | "lightstone_verification"
    | "lightstone_repair"
    | "car_vertical"
    | "bmw_options"
    | "mb_options"
    | "outvin_spec"
    | "landrover_osh"
    | "kredo_vin_history"
    | "porsche_vin";
  name: string;
  cost_zar: number;
  status: "pending" | "delivered" | "failed";
  ordered_at: string;
  delivered_at?: string | null;
  vin?: string;
  note?: string;
  result_data?: Record<string, any> | null;
};

export type TyreEstimate = {
  tyre_spec?: string;
  per_tyre_range_zar?: { low: number; high: number; typical: number };
  set_of_four_zar?: { low: number; high: number; typical: number };
  fitment_and_balance_zar?: number;
  total_replacement_estimate_zar?: number;
  recommended_brands?: string[];
  notes?: string;
  confidence?: "low" | "medium" | "high";
  disclaimer?: string;
  raw?: string;
};

export type TyreEstimatePayload = {
  estimate: TyreEstimate;
  rim_size?: number | null;
  generated_at: string;
  model: string;
};

export type MarketAnalysis = {
  estimated_market_range_zar?: { low: number; high: number; typical: number };
  trade_price_estimate_zar?: number;
  retail_price_estimate_zar?: number;
  year_positioning?: string;
  mileage_positioning?: string;
  listings_summary?: string;
  key_factors?: string[];
  kredo_alignment?: string;
  margin_pct?: number;
  recon_impact_zar?: number;
  confidence?: "low" | "medium" | "high";
  disclaimer?: string;
  raw?: string;
};

export type MarketAnalysisPayload = {
  analysis: MarketAnalysis;
  generated_at: string;
  model: string;
};

/** Canonical valuation submission shape used by the dealer / admin /
 *  pricing-agent views. See the backend serializer for which fields
 *  are stripped for the sanitised cover-mode payload sent to Pricing
 *  Agents. */
export type Submission = {
  id: string;
  reference?: string;
  dealer_id: string;
  dealership_id?: string | null;
  dealer_name?: string;
  dealer_first_name?: string;
  dealer_phone?: string;
  dealer_email?: string;
  company_name?: string;
  submitted_by_user_id?: string | null;
  submitted_by_name?: string | null;
  submitted_by_job_title?: string | null;
  submitted_at?: string | null;
  make_name: string;
  model_name: string;
  derivative_name: string;
  /** Optional dealer branding — populated for owner-dealership members
   *  and admins so we can show a WhatsApp-Business-style banner on the
   *  vehicle detail page. Pricing agents never receive these. */
  submitter_profile_pic?: string | null;
  submitter_cover_photo?: string | null;
  fuel_type?: string;
  year_of_production?: number;
  transmission?: string;
  year_registered?: number;
  variant_manufacture_range?: { min: number; max: number } | null;
  registered_after_discontinued?: boolean;
  mileage: number;
  year: number;
  factory_warranty?: boolean;
  factory_warranty_status?: "active" | "expired" | null;
  maintenance_plan_status?: "active" | "expired" | null;
  service_plan_status?: "active" | "expired" | null;
  condition: number;
  /** Legacy fields — may still exist on older submissions. */
  exterior_condition?: number;
  tyre_condition?: number;
  /** Four condition pillars. */
  mechanical_condition?: number;
  cosmetic_condition?: number;
  interior_condition?: number;
  history_condition?: number;
  windscreen_condition?: string;
  service_history?: string;
  last_service_date?: string;
  last_service_mileage?: number | null;
  paint_evidence?: boolean;
  paint_quality?: string | null;
  accident_damage: boolean;
  accident_damage_types?: string[];
  reconditioning_items?: ReconItem[];
  reconditioning_total_zar?: number;
  colour: string;
  vin?: string;
  engine_number?: string;
  license_disk_data?: string;
  photos: Record<string, string>;
  status: "pending" | "priced" | "declined";
  declined_at?: string | null;
  price: number | null;
  price_notes?: string | null;
  priced_at?: string | null;
  price_history?: PriceHistoryEntry[];
  market_analysis?: MarketAnalysisPayload | null;
  market_analysis_at?: string | null;
  tyre_estimate?: TyreEstimatePayload | null;
  tyre_estimate_at?: string | null;
  created_at: string;
  report_orders?: ReportOrder[];
  /** Dealer-only deal tracking (never visible to pricing agents — the
   *  backend strips these fields from the sanitised cover-mode
   *  payload). */
  deal?: DealInfo | null;
  deal_profit?: DealProfit | null;
};

/** Photo slot ordering matches the submit flow: front, driver_side,
 *  passenger_side, rear, interior. Old submissions used
 *  side_right/side_left — we fall back to those keys when the newer
 *  ones are missing. */
export const PHOTO_ORDER: { key: string; fallback?: string; label: string }[] = [
  { key: "front", label: "Front" },
  { key: "driver_side", fallback: "side_right", label: "Driver's Side" },
  { key: "passenger_side", fallback: "side_left", label: "Passenger Side" },
  { key: "rear", label: "Rear" },
  { key: "interior", label: "Interior" },
];
