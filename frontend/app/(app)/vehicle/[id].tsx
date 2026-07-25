import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Image, TextInput, Modal, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { TOKEN_KEY } from "@/src/api";
import { useAuth } from "@/src/context/AuthContext";
import { buildWhatsappUrl, buildDealerMessage } from "@/src/utils/whatsapp";
import { decodeLicenseDisk } from "@/src/utils/licenseDisk";
import PhotoCarousel, { CarouselPhoto } from "@/src/components/PhotoCarousel";
import ConditionRatingInfoModal from "@/src/components/ConditionRatingInfoModal";
import BrandLogo from "@/src/components/BrandLogo";
import { formatZAR, computeServiceGap, formatMonthsAgo, formatKm } from "@/src/utils/format";

type ReconItem = {
  // Legacy free-text label + single photo, and new category + multi-photo.
  // Both are supported here so we can render historical submissions unchanged.
  label: string;
  category?: string | null;
  amount_zar: number;
  photo?: string | null;
  photos?: string[];
};

type Submission = {
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
  condition: number;
  // Legacy (may exist on older submissions)
  exterior_condition?: number;
  tyre_condition?: number;
  // Four condition pillars
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
};

type PriceHistoryEntry = {
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

type ReportOrder = {
  id: string;
  submission_id: string;
  type: "lightstone_verification" | "lightstone_repair" | "car_vertical" | "bmw_options" | "landrover_osh";
  name: string;
  cost_zar: number;
  status: "pending" | "delivered" | "failed";
  ordered_at: string;
  delivered_at?: string | null;
  vin?: string;
  note?: string;
  result_data?: Record<string, any> | null;
};

type TyreEstimate = {
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

type TyreEstimatePayload = {
  estimate: TyreEstimate;
  rim_size?: number | null;
  generated_at: string;
  model: string;
};

type MarketAnalysis = {
  estimated_market_range_zar?: { low: number; high: number; typical: number };
  trade_price_estimate_zar?: number;
  retail_price_estimate_zar?: number;
  listings_summary?: string;
  key_factors?: string[];
  kredo_alignment?: string;
  recon_impact_zar?: number;
  confidence?: "low" | "medium" | "high";
  disclaimer?: string;
  raw?: string;
};

type MarketAnalysisPayload = {
  analysis: MarketAnalysis;
  generated_at: string;
  model: string;
};

// Photo slot ordering matches the submit flow: front, driver_side,
// passenger_side, rear, interior. Old submissions used side_right/side_left —
// we fall back to those keys when the newer ones are missing.
const PHOTO_ORDER: { key: string; fallback?: string; label: string }[] = [
  { key: "front", label: "Front" },
  { key: "driver_side", fallback: "side_right", label: "Driver's Side" },
  { key: "passenger_side", fallback: "side_left", label: "Passenger Side" },
  { key: "rear", label: "Rear" },
  { key: "interior", label: "Interior" },
];

function resolvePhoto(photos: Record<string, string>, key: string, fallback?: string) {
  return photos?.[key] || (fallback ? photos?.[fallback] : "") || "";
}

/** Format a Kredo market-value amount in R with no decimals. */
function formatMV(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v) || v === 0) return "—";
  return `R${Number(v).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`;
}

/** Compact "fetched X ago" label for the Kredo market-values footer. */
function formatFetched(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  try {
    const d = typeof iso === "string" ? new Date(iso) : iso;
    if (Number.isNaN(d.getTime())) return "";
    const diffSec = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return "just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hr ago`;
    return d.toLocaleDateString("en-ZA");
  } catch {
    return "";
  }
}

/**
 * Cross-platform "OK / Cancel" confirmation.
 *
 * `Alert.alert(title, msg, buttons)` renders the buttons natively on iOS/
 * Android, but the react-native-web implementation shows the message and
 * silently drops the buttons — so on the web preview the user has no way to
 * confirm or cancel. This helper falls back to `window.confirm` on web so
 * flows like admin pricing/deletion/report ordering still work there.
 */
function confirmAsync(title: string, message: string, confirmLabel = "Confirm"): Promise<boolean> {
  return new Promise((resolve) => {
    if (Platform.OS === "web") {
      const combined = title ? `${title}\n\n${message}` : message;
      // eslint-disable-next-line no-alert
      const ok = typeof window !== "undefined" && window.confirm(combined);
      resolve(ok);
      return;
    }
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: confirmLabel, style: "default", onPress: () => resolve(true) },
    ]);
  });
}

export default function VehicleDetail() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [sub, setSub] = useState<Submission | null>(null);
  const [loading, setLoading] = useState(true);
  const [priceModal, setPriceModal] = useState(false);
  const [priceInput, setPriceInput] = useState("");
  const [notesInput, setNotesInput] = useState("");
  const [changeCommentInput, setChangeCommentInput] = useState("");
  const [submittingPrice, setSubmittingPrice] = useState(false);
  const [carouselIdx, setCarouselIdx] = useState<number | null>(null);
  const [conditionInfoOpen, setConditionInfoOpen] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [estimatingTyres, setEstimatingTyres] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // VIN reports & valuation PDF
  const [orderingReportType, setOrderingReportType] = useState<
    "lightstone_verification" | "lightstone_repair" | "car_vertical" | null
  >(null);
  const [confirmReport, setConfirmReport] = useState<
    { type: ReportOrder["type"]; name: string; cost_zar: number } | null
  >(null);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [viewingReport, setViewingReport] = useState<ReportOrder | null>(null);
  // Kredo market values (new list / M&M / trade / retail) — cached on the
  // submission document. `marketValues` mirrors `sub.market_values` so the
  // refresh CTA can flip the panel to a "loading" state without waiting
  // for the whole GET to re-fetch.
  const [marketValuesLoading, setMarketValuesLoading] = useState(false);

  // Kredo market values snapshot mirrored off the submission. `null` means
  // the endpoint hasn't returned yet (initial fetch pending).
  const marketValues: any = (sub as any)?.market_values ?? null;

  // While the backend is still fetching Kredo values, quietly re-poll the
  // submission every 3s so the card transitions from "Fetching…" → the
  // real values without the user having to tap Refresh.
  useEffect(() => {
    if (!id) return;
    if (!marketValues || marketValues.status !== "loading") return;
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      while (!cancelled && attempts < 20) {
        attempts += 1;
        await new Promise((r) => setTimeout(r, 3000));
        if (cancelled) return;
        try {
          const r = await apiFetch(`/api/submissions/${id}`);
          const mv = r?.submission?.market_values;
          if (mv && mv.status !== "loading") {
            setSub((prev) => (prev ? { ...prev, market_values: mv } : prev));
            return;
          }
        } catch {
          // ignore — try again next tick
        }
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [id, marketValues?.status]);

  const refreshMarketValues = async () => {
    if (!id || marketValuesLoading) return;
    setMarketValuesLoading(true);
    try {
      const r = await apiFetch(`/api/submissions/${id}/market-values/refresh`, {
        method: "POST",
      });
      setSub((prev) => (prev ? { ...prev, market_values: r.market_values } : prev));
    } catch (e: any) {
      Alert.alert("Refresh failed", e?.message || "Could not refresh market values.");
    } finally {
      setMarketValuesLoading(false);
    }
  };

  // Bimmervin factory spec (BMW / MINI / Rolls-Royce / ALPINA) — admin-only,
  // on-demand button. First call spends ~3 credits (~€3 = R60); subsequent
  // calls for the same VIN come back cached for free.
  const bimmerSpec: any = (sub as any)?.bimmer_spec ?? null;
  const [bimmerLoading, setBimmerLoading] = useState(false);
  const isBimmerSupported = useMemo(() => {
    const mk = (sub?.make_name || (sub as any)?.make || "").toString().toUpperCase();
    // BMW factory options via Bimmervin — currently sold for BMW and MINI
    // only. Backend catalog is the source of truth (via supported_makes),
    // this frontend gate mirrors it so we don't render the row prematurely
    // before the catalog endpoint returns.
    return ["BMW", "MINI"].includes(mk);
  }, [sub?.make_name]);

  // JLR OSH service-history report — offered on Land Rover / Range Rover
  // / Jaguar submissions. Mirrors the backend catalog's `supported_makes`
  // list so admins never see the row on non-JLR vehicles.
  const isLandroverSupported = useMemo(() => {
    const mk = (sub?.make_name || (sub as any)?.make || "").toString().toUpperCase();
    return ["LAND ROVER", "LAND-ROVER", "LANDROVER", "RANGE ROVER", "RANGE-ROVER", "JAGUAR"].includes(mk);
  }, [sub?.make_name]);

  const fetchBimmerSpec = async () => {
    if (!id || bimmerLoading) return;
    setBimmerLoading(true);
    try {
      const r = await apiFetch(`/api/admin/submissions/${id}/bimmer-spec`, {
        method: "POST",
      });
      setSub((prev) => (prev ? { ...prev, bimmer_spec: r.bimmer_spec } : prev));
      if (r?.bimmer_spec?.status !== "ok") {
        Alert.alert(
          "Factory spec",
          r?.bimmer_spec?.error || "Could not fetch factory spec.",
        );
      }
    } catch (e: any) {
      Alert.alert("Factory spec", e?.message || "Could not fetch factory spec.");
    } finally {
      setBimmerLoading(false);
    }
  };
  const [declineModal, setDeclineModal] = useState(false);
  const [declineNote, setDeclineNote] = useState("");
  const [declining, setDeclining] = useState(false);

  // Kredo VIN accident history (admin-only)
  type KredoClaim = {
    id: string;
    accident_date: string | null;
    creation_date: string | null;
    country: string | null;
    manufacturer: string | null;
    model: string | null;
    mileage_at_claim: string | null;
    first_registration: string | null;
    damage_locations: string[];
    glass_damage: boolean;
  };
  type KredoHistory = {
    result: { claim_count: number; claims: KredoClaim[] };
    cached_at: string | null;
    source: "kredo" | "cache";
  };
  const [kredoHistory, setKredoHistory] = useState<KredoHistory | null>(null);
  const [kredoLoading, setKredoLoading] = useState(false);

  // Kredo CarTrust PDF (async report, order + webhook + Cloudinary hosted)
  type CartrustReport = {
    status: "pending" | "completed" | "failed";
    ordered_at?: string | null;
    completed_at?: string | null;
    failed_at?: string | null;
    ordered_by_email?: string | null;
    pdf_url?: string | null;
    cost_zar?: number | null;
    error?: string | null;
  };
  const [cartrust, setCartrust] = useState<CartrustReport | null>(null);
  const [cartrustLoading, setCartrustLoading] = useState(false);

  // Per-fetch price the dealer pays for a live Kredo VIN accident /
  // claim history lookup. Cache hits are free — the charge is recorded
  // exactly once per submission by the backend. Kept in sync with
  // KREDO_VIN_HISTORY_DEALER_COST_ZAR on the server.
  const KREDO_VIN_HISTORY_DEALER_COST_ZAR = 100;

  const fetchKredoHistory = async (refresh = false) => {
    if (!sub?.id || !sub.vin) return;
    // Dealers must explicitly accept the R100 charge — only when this
    // will actually hit Kredo (i.e., no cache yet OR they tapped Refresh).
    const willBill = !isAdmin && (refresh || !kredoHistory);
    if (willBill) {
      const proceed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          "Accident / Claim History",
          `A live Kredo VIN accident-and-claim check for ${sub.vin} will be added to your next invoice at R${KREDO_VIN_HISTORY_DEALER_COST_ZAR}. Continue?`,
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            { text: `Charge R${KREDO_VIN_HISTORY_DEALER_COST_ZAR}`, style: "default", onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        );
      });
      if (!proceed) return;
    }
    setKredoLoading(true);
    try {
      const r = await apiFetch("/api/kredo/vin-history", {
        method: "POST",
        body: JSON.stringify({
          vin: sub.vin.trim().toUpperCase(),
          submission_id: sub.id,
          refresh,
          accepted_charge: willBill,
        }),
      });
      setKredoHistory(r as KredoHistory);
    } catch (e: any) {
      Alert.alert(
        "Accident / Claim History",
        e?.message || "Could not fetch accident history from Kredo.",
      );
    } finally {
      setKredoLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch(`/api/submissions/${id}`);
        setSub(data.submission);
      } catch (e: any) {
        Alert.alert("Error", e.message);
        router.back();
      } finally {
        setLoading(false);
      }
    })();
  }, [id, router]);

  // Auto-load cached Kredo VIN history for admins on mount. `cache_only`
  // means we NEVER hit Kredo on page load — only surface a previously
  // fetched result. The user has to click the button to make a fresh call.
  useEffect(() => {
    if (!isAdmin || !sub?.id || !sub.vin) return;
    if (sub.vin.trim().toUpperCase() === "TBC") return;
    (async () => {
      try {
        const r = await apiFetch("/api/kredo/vin-history", {
          method: "POST",
          body: JSON.stringify({
            vin: sub.vin!.trim().toUpperCase(),
            submission_id: sub.id,
            cache_only: true,
          }),
        });
        if (r?.result) setKredoHistory(r as KredoHistory);
      } catch {
        // Silent — the manual "Fetch" button remains available in the UI.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, sub?.id, sub?.vin]);

  // Load CarTrust status on mount (dealer + admin), then poll while pending.
  const loadCartrustStatus = async () => {
    if (!sub?.id) return;
    try {
      const r = await apiFetch(`/api/kredo/cartrust/status/${sub.id}`);
      setCartrust((r?.report as CartrustReport | null) || null);
    } catch {
      // Silent
    }
  };

  useEffect(() => {
    if (!sub?.id) return;
    loadCartrustStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub?.id]);

  useEffect(() => {
    if (!sub?.id || cartrust?.status !== "pending") return;
    const t = setInterval(loadCartrustStatus, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub?.id, cartrust?.status]);

  const orderCartrust = async () => {
    if (!sub?.id) return;
    setCartrustLoading(true);
    try {
      const r = await apiFetch("/api/kredo/cartrust/order", {
        method: "POST",
        body: JSON.stringify({ submission_id: sub.id }),
      });
      setCartrust((r?.report as CartrustReport | null) || null);
      Alert.alert(
        "CarTrust ordered",
        "Kredo is preparing your report. This can take a few minutes — we'll notify you here when it's ready.",
      );
    } catch (e: any) {
      Alert.alert("CarTrust order failed", e?.message || "Could not place the order.");
    } finally {
      setCartrustLoading(false);
    }
  };

  const openCartrust = async () => {
    if (!cartrust) return;
    try {
      // Fetch the PDF through our authenticated backend endpoint, save
      // to a local temp file, then hand it to expo-file-system's sharing
      // dialog / the native PDF viewer. This works both on device and
      // in web preview, and doesn't rely on the (now expired) presigned
      // Kredo S3 URL.
      const token = await storage.getItem(TOKEN_KEY);
      const url = `${process.env.EXPO_PUBLIC_BACKEND_URL}/api/kredo/cartrust/pdf/${sub.id}`;
      // On web we can just open with the Authorization header via a fetch
      // + blob URL trick. On native, expo-web-browser can open a URL
      // that already carries auth via a query-string bearer — but our
      // API only accepts headers, so we blob it locally instead.
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
      const blob = await res.blob();
      if (Platform.OS === "web") {
        const objUrl = URL.createObjectURL(blob);
        await WebBrowser.openBrowserAsync(objUrl);
        // Revoke a minute later to give the tab time to load.
        setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
      } else {
        // Convert to base64 and write to cache dir, then open with the OS.
        const b64: string = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        const path = `${FileSystem.cacheDirectory}cartrust_${sub.id}.pdf`;
        await FileSystem.writeAsStringAsync(path, b64, { encoding: FileSystem.EncodingType.Base64 });
        await WebBrowser.openBrowserAsync(path);
      }
    } catch (e: any) {
      Alert.alert("Could not open PDF", e?.message || String(e));
    }
  };

  // Auto-refresh whenever the screen regains focus (e.g. dealer navigates
  // back to this vehicle after an admin has posted a price offer). Without
  // this the screen would stay stuck on "AWAITING PRICE OFFER" until the
  // dealer manually pulls to refresh or fully closes and reopens the app.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const data = await apiFetch(`/api/submissions/${id}`);
          if (!cancelled) setSub(data.submission);
        } catch {
          /* silent — the initial load already surfaced errors */
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [id])
  );

  const carouselPhotos: CarouselPhoto[] = useMemo(() => {
    if (!sub) return [];
    const main = PHOTO_ORDER.map((p) => ({
      uri: resolvePhoto(sub.photos || {}, p.key, p.fallback),
      label: p.label,
    })).filter((p) => !!p.uri);
    // Append any reconditioning photos so tapping a recon thumbnail opens
    // the shared full-screen carousel. Supports both new multi-photo
    // (`photos: []`) and legacy single (`photo: string`) shapes.
    const reconPhotos: CarouselPhoto[] = (sub.reconditioning_items || []).flatMap((r) => {
      const label = r.category || r.label || "Recon";
      const list = Array.isArray(r.photos) && r.photos.length > 0
        ? r.photos
        : r.photo
          ? [r.photo]
          : [];
      return list.map((uri) => ({ uri: uri as string, label: `Recon · ${label}` }));
    });
    return [...main, ...reconPhotos];
  }, [sub]);

  const averageRating = useMemo(() => {
    if (!sub) return null;
    // New submissions use the four weighted pillars. Weightings:
    //   Mechanical 30% · Cosmetic 25% · Interior 25% · General 20%.
    const m = sub.mechanical_condition;
    const c = sub.cosmetic_condition;
    const i = sub.interior_condition;
    const h = sub.history_condition;
    if ([m, c, i, h].every((x) => typeof x === "number" && x > 0)) {
      return (m as number) * 0.3 + (c as number) * 0.25 + (i as number) * 0.25 + (h as number) * 0.2;
    }
    // Partial pillar data → weighted score over just the pillars we have,
    // renormalising the weights so they still sum to 1.
    const partial: [number, number][] = [
      [m as number, 0.3],
      [c as number, 0.25],
      [i as number, 0.25],
      [h as number, 0.2],
    ].filter(([v]) => typeof v === "number" && v > 0) as [number, number][];
    if (partial.length > 0) {
      const totalW = partial.reduce((s, [, w]) => s + w, 0);
      return partial.reduce((s, [v, w]) => s + v * w, 0) / totalW;
    }
    // Legacy submissions (pre-pillar rewrite) fall back to a simple average.
    const legacy = [sub.exterior_condition, sub.interior_condition, sub.tyre_condition].filter(
      (x): x is number => typeof x === "number" && x > 0
    );
    if (legacy.length === 0) return null;
    return legacy.reduce((a, b) => a + b, 0) / legacy.length;
  }, [sub]);

  const handleOfferPrice = async () => {
    const price = parseFloat(priceInput.replace(/[^0-9.]/g, ""));
    if (isNaN(price) || price <= 0) {
      Alert.alert("Invalid price", "Please enter a valid price");
      return;
    }
    // Two-step confirmation: the "Confirm Price" button in the modal is
    // the FIRST step; this final confirmation is the explicit second step
    // so admins can't accidentally submit a wrong number.
    const vehicleLabel = `${sub?.year ?? ""} ${sub?.make_name ?? ""} ${sub?.model_name ?? ""}`.trim();
    const ok = await confirmAsync(
      "Confirm price",
      `Offer ${formatZAR(price)} for ${vehicleLabel}?\n\nThis will be shown to the dealer immediately.`,
      "Confirm price",
    );
    if (!ok) return;

    setSubmittingPrice(true);
    try {
      await apiFetch(`/api/admin/submissions/${id}/price`, {
        method: "POST",
        body: JSON.stringify({
          price,
          notes: notesInput.trim() || null,
          change_comment: changeCommentInput.trim() || null,
        }),
      });
      const refreshed = await apiFetch(`/api/submissions/${id}`);
      setSub(refreshed.submission);
      setPriceModal(false);
      setPriceInput("");
      setNotesInput("");
      setChangeCommentInput("");
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setSubmittingPrice(false);
    }
  };

  const handleDeclineOffer = async () => {
    if (!sub) return;
    setDeclining(true);
    try {
      await apiFetch(`/api/admin/submissions/${id}/decline`, {
        method: "POST",
        body: JSON.stringify({ admin_note: declineNote.trim() || null }),
      });
      const refreshed = await apiFetch(`/api/submissions/${id}`);
      setSub(refreshed.submission);
      setDeclineModal(false);
      setDeclineNote("");
    } catch (e: any) {
      Alert.alert("Could not decline", e.message || "Please try again.");
    } finally {
      setDeclining(false);
    }
  };

  const handleMarketAnalysis = async () => {
    if (!sub) return;
    setAnalysing(true);
    try {
      const data = await apiFetch(`/api/submissions/${id}/market-analysis`, { method: "POST" });
      setSub({ ...sub, market_analysis: data, market_analysis_at: data.generated_at });
    } catch (e: any) {
      Alert.alert("Analysis failed", e.message);
    } finally {
      setAnalysing(false);
    }
  };

  const handleTyreEstimate = async () => {
    if (!sub) return;
    setEstimatingTyres(true);
    try {
      const data = await apiFetch(`/api/submissions/${id}/tyre-estimate`, { method: "POST" });
      setSub({ ...sub, tyre_estimate: data, tyre_estimate_at: data.generated_at });
    } catch (e: any) {
      Alert.alert("Tyre estimate failed", e.message);
    } finally {
      setEstimatingTyres(false);
    }
  };

  const REPORT_CATALOG: Record<
    ReportOrder["type"] | "kredo_cartrust",
    { name: string; cost_zar: number }
  > = {
    lightstone_verification: { name: "Lightstone Vehicle Verification Report", cost_zar: 100 },
    lightstone_repair: { name: "Lightstone Vehicle Repair History Report", cost_zar: 50 },
    car_vertical: { name: "Car Vertical Report", cost_zar: 200 },
    kredo_cartrust: { name: "Kredo CarTrust Vehicle Report", cost_zar: 200 },
    // BMW factory options — live Bimmervin lookup, only offered on
    // BMW and MINI vehicles.
    bmw_options: { name: "BMW Factory Options", cost_zar: 20 },
    // JLR Online Service History — live osh.landrover.com scrape, only
    // offered on Land Rover / Range Rover / Jaguar vehicles.
    landrover_osh: { name: "Land Rover / Jaguar Service History", cost_zar: 20 },
  };

  const orderedReportTypes = useMemo(
    () => new Set((sub?.report_orders || []).map((r) => r.type)),
    [sub?.report_orders]
  );

  const submitReportOrder = async () => {
    if (!sub || !confirmReport) return;
    // Kredo CarTrust has its own async flow — route through orderCartrust()
    // instead of the standard /reports POST.
    if ((confirmReport.type as string) === "kredo_cartrust") {
      setConfirmReport(null);
      await orderCartrust();
      return;
    }
    setOrderingReportType(confirmReport.type);
    try {
      const res = await apiFetch(`/api/submissions/${id}/reports`, {
        method: "POST",
        body: JSON.stringify({ type: confirmReport.type, accepted_charge: true }),
      });
      setSub({
        ...sub,
        report_orders: [res.order, ...(sub.report_orders || [])],
      });
      setConfirmReport(null);
      Alert.alert(
        "Report Ordered",
        `${confirmReport.name} has been ordered. The charge of R${confirmReport.cost_zar.toFixed(0)} will be added to your next invoice. Results will populate once the provider responds.`
      );
    } catch (e: any) {
      Alert.alert("Order failed", e.message || "Could not place the report order");
    } finally {
      setOrderingReportType(null);
    }
  };

  const handleDownloadPdf = async () => {
    if (!sub) return;
    setDownloadingPdf(true);
    try {
      const backend = process.env.EXPO_PUBLIC_BACKEND_URL;
      if (!backend) throw new Error("Missing EXPO_PUBLIC_BACKEND_URL");
      const path = `/api/submissions/${sub.id}/valuation.pdf`;
      const token = await storage.secureGet<string>(TOKEN_KEY, "");
      const filename = `valuation_${sub.reference || sub.id}.pdf`;

      if (Platform.OS === "web") {
        // Fetch as blob, then trigger a download link.
        const res = await fetch(`${backend}${path}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`Server returned HTTP ${res.status} ${errText.slice(0, 120)}`);
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        // Open in a new tab so the user gets an inline PDF preview and can
        // then decide to download it. This matches the mobile UX below.
        window.open(objectUrl, "_blank");
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      } else {
        // Native: open the PDF inline inside an in-app browser (which previews
        // PDFs on both iOS and Android). The token is passed as a query param
        // because mobile in-app browsers cannot forward custom headers.
        const url = `${backend}${path}?access_token=${encodeURIComponent(token || "")}`;
        const opened = await WebBrowser.openBrowserAsync(url, {
          dismissButtonStyle: "close",
          controlsColor: colors.text,
          toolbarColor: colors.paper,
          enableBarCollapsing: true,
        });
        // If WebBrowser fails to open (very rare), fall back to download+share.
        if (opened.type === "cancel" || opened.type === "dismiss") {
          // User just closed the preview — nothing to do.
          return;
        }
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("[valuation-pdf] preview failed:", e);
      // Last-ditch fallback: download to cache and hand off to Sharing so the
      // user still gets the PDF somehow.
      try {
        const backend = process.env.EXPO_PUBLIC_BACKEND_URL;
        const token = await storage.secureGet<string>(TOKEN_KEY, "");
        const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
        if (cacheDir && sub) {
          const target = `${cacheDir}valuation_${sub.reference || sub.id}.pdf`;
          const dl = await FileSystem.downloadAsync(
            `${backend}/api/submissions/${sub.id}/valuation.pdf`,
            target,
            { headers: token ? { Authorization: `Bearer ${token}` } : undefined }
          );
          if (dl.status >= 200 && dl.status < 300) {
            const canShare = await Sharing.isAvailableAsync();
            if (canShare) {
              await Sharing.shareAsync(dl.uri, {
                mimeType: "application/pdf",
                dialogTitle: "Valuation PDF",
                UTI: "com.adobe.pdf",
              });
              return;
            }
          }
        }
      } catch (fallbackErr) {
        // eslint-disable-next-line no-console
        console.error("[valuation-pdf] fallback share failed:", fallbackErr);
      }
      Alert.alert(
        "Preview failed",
        e?.message ? String(e.message) : "Could not open the valuation PDF. Please try again."
      );
    } finally {
      setDownloadingPdf(false);
    }
  };

  const handleOpenReportPdf = async (reportType: ReportOrder["type"]) => {
    if (!sub) return;
    try {
      const backend = process.env.EXPO_PUBLIC_BACKEND_URL;
      if (!backend) throw new Error("Missing EXPO_PUBLIC_BACKEND_URL");
      const path = `/api/submissions/${sub.id}/reports/${reportType}.pdf`;
      const token = await storage.secureGet<string>(TOKEN_KEY, "");

      if (Platform.OS === "web") {
        const res = await fetch(`${backend}${path}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        window.open(objectUrl, "_blank");
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      } else {
        const url = `${backend}${path}?access_token=${encodeURIComponent(token || "")}`;
        await WebBrowser.openBrowserAsync(url, {
          dismissButtonStyle: "close",
          controlsColor: colors.text,
          toolbarColor: colors.paper,
        });
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("[report-pdf] open failed:", e);
      Alert.alert(
        "Preview failed",
        e?.message ? String(e.message) : "Could not open the report PDF."
      );
    }
  };

  const handleDelete = async () => {
    if (!sub) return;
    const ok = await confirmAsync(
      "Delete Vehicle",
      `Permanently remove ${sub.reference ?? "this submission"}? This cannot be undone.`,
      "Delete",
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/admin/submissions/${id}`, { method: "DELETE" });
      router.back();
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setDeleting(false);
    }
  };

  if (loading || !sub) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="detail-back-button" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {sub.reference ?? `${sub.year} ${sub.make_name}`}
        </Text>
        {isAdmin ? (
          <TouchableOpacity testID="delete-vehicle-button" onPress={handleDelete} disabled={deleting} style={styles.deleteBtn}>
            {deleting ? (
              <ActivityIndicator color={colors.danger} size="small" />
            ) : (
              <Ionicons name="trash-outline" size={22} color={colors.danger} />
            )}
          </TouchableOpacity>
        ) : (
          <BrandLogo size="xs" linkToHome />
        )}
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Unseen banner — loud red warning shown to both dealers and admins
            immediately at the top of the vehicle detail so the "Cover Price"
            below is never mistaken for an inspection-backed number. */}
        {sub.unseen ? (
          <View style={styles.unseenBanner} testID="unseen-banner">
            <Ionicons name="eye-off" size={18} color="#B3261E" />
            <View style={{ flex: 1 }}>
              <Text style={styles.unseenBannerTitle}>Vehicle Unseen — Subject to View & Less to Spend</Text>
              <Text style={styles.unseenBannerHint}>
                Desktop valuation. Fourbuy has NOT physically inspected the vehicle. Final cover will adjust at inspection.
              </Text>
            </View>
          </View>
        ) : null}

        {/* Reference badge */}
        {sub.reference ? (
          <View style={styles.refBadge}>
            <Text style={styles.refBadgeLabel}>REFERENCE</Text>
            <Text style={styles.refBadgeValue}>{sub.reference}</Text>
          </View>
        ) : null}

        {/* Submitted-by chip — shows which team member captured this
            valuation. All users of a dealership can see this. */}
        {sub.submitted_by_name ? (
          <View style={styles.submittedByChip} testID="submitted-by-chip">
            <Ionicons name="person-circle-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.submittedByText}>
              Submitted by <Text style={styles.submittedByBold}>{sub.submitted_by_name}</Text>
              {sub.submitted_by_job_title ? ` · ${sub.submitted_by_job_title}` : ""}
              {sub.submitted_at ? ` · ${(sub.submitted_at || "").slice(0, 10)}` : ""}
            </Text>
          </View>
        ) : null}

        {/* Submitted By — admin view of the dealer contact card with
            direct WhatsApp button. Kept at the TOP of the page so admins
            can reach out immediately when reviewing a submission. */}
        {isAdmin && sub.dealer_name ? (
          <>
            <Text style={styles.sectionTitle}>Submitted By</Text>
            <View style={styles.dealerBox}>
              <Text style={styles.dealerName}>{sub.dealer_name}</Text>
              <Text style={styles.dealerCompany}>{sub.company_name}</Text>
              <Text style={styles.dealerEmail}>{sub.dealer_email}</Text>
              {sub.dealer_phone ? (
                <Text style={styles.dealerEmail}>{sub.dealer_phone}</Text>
              ) : null}
              {sub.dealer_phone ? (
                <TouchableOpacity
                  testID="whatsapp-dealer-button"
                  style={styles.whatsappBtn}
                  onPress={() => {
                    const url = buildWhatsappUrl(
                      sub.dealer_phone!,
                      buildDealerMessage({
                        dealerFirstName: sub.dealer_first_name,
                        reference: sub.reference,
                        year: sub.year,
                        make: sub.make_name,
                        model: sub.model_name,
                        derivative: sub.derivative_name,
                        price: sub.price,
                        priceNotes: sub.price_notes,
                      })
                    );
                    Linking.openURL(url);
                  }}
                >
                  <Ionicons name="logo-whatsapp" size={18} color="#25D366" />
                  <Text style={styles.whatsappBtnText}>Contact on WhatsApp</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </>
        ) : null}

        {/* Title */}
        <View style={styles.titleBox}>
          <Text style={styles.brand}>{sub.make_name}</Text>
          <Text style={styles.model}>{sub.model_name}</Text>
          <Text style={styles.derivative}>{sub.derivative_name}</Text>
        </View>

        {/* Vehicle Details — vertical spec list, easy to scan top-to-bottom */}
        <Text style={styles.sectionTitle}>Vehicle Details</Text>
        {sub.registered_after_discontinued && sub.variant_manufacture_range ? (
          <View style={styles.discontinuedBanner} testID="discontinued-banner">
            <Ionicons name="alert-circle" size={16} color={colors.warning} />
            <Text style={styles.discontinuedBannerText}>
              Registered {sub.year_registered ?? sub.year} · this variant was discontinued after {sub.variant_manufacture_range.max}. Kredo valuation reference uses year model {sub.year_of_production ?? sub.variant_manufacture_range.max}.
            </Text>
          </View>
        ) : null}
        <View style={styles.detailsList}>
          <DetailRow label="Year Registered" value={String(sub.year_registered ?? sub.year)} />
          <DetailRow label="Make" value={sub.make_name} />
          <DetailRow label="Model" value={sub.model_name} />
          <DetailRow label="Derivative" value={sub.derivative_name} />
          <DetailRow label="Mileage" value={`${sub.mileage.toLocaleString()} km`} />
          <DetailRow label="Transmission" value={sub.transmission ?? "—"} />
          <DetailRow label="Fuel Type" value={sub.fuel_type ?? "—"} />
          <DetailRow label="Colour" value={sub.colour} />
          <DetailRow
            label="Year of Production"
            value={String(sub.year_of_production ?? sub.year)}
            last
          />
        </View>

        {/* Photos */}
        <Text style={styles.sectionTitle}>Photos</Text>
        <View style={styles.photoGrid}>
          {PHOTO_ORDER.map((p, i) => {
            const uri = resolvePhoto(sub.photos || {}, p.key, p.fallback);
            return (
              <TouchableOpacity
                key={p.key}
                testID={`detail-photo-${p.key}`}
                style={styles.photoSlot}
                onPress={() => {
                  if (!uri) return;
                  // Find the actual index in the filtered carouselPhotos list.
                  const idx = carouselPhotos.findIndex((c) => c.uri === uri);
                  if (idx >= 0) setCarouselIdx(idx);
                }}
                activeOpacity={uri ? 0.7 : 1}
              >
                {uri ? (
                  <>
                    <Image source={{ uri }} style={styles.photoImg} />
                    <View style={styles.photoOverlay}>
                      <Text style={styles.photoLabel}>{p.label.toUpperCase()}</Text>
                      <Ionicons name="expand-outline" size={14} color="#fff" />
                    </View>
                  </>
                ) : (
                  <>
                    <Ionicons name="image-outline" size={20} color={colors.textDisabled} />
                    <Text style={styles.photoLabelDim}>{p.label.toUpperCase()}</Text>
                  </>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Status banner */}
        {sub.status === "priced" ? (
          <View style={styles.priceBanner} testID="price-banner">
            <View>
              <Text style={styles.priceLabel}>OFFER RECEIVED</Text>
              <Text style={styles.priceValue}>{formatZAR(sub.price)}</Text>
              {sub.price_notes ? <Text style={styles.priceNotes}>{sub.price_notes}</Text> : null}
            </View>
            <Ionicons name="checkmark-circle" size={40} color={colors.text} />
          </View>
        ) : sub.status === "declined" ? (
          <View style={styles.declinedBanner} testID="declined-banner">
            <View style={styles.declinedIconWrap}>
              <Ionicons name="close-circle-outline" size={40} color={colors.text} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.declinedLabel}>NO OFFER MADE</Text>
              <Text style={styles.declinedBody}>
                We unfortunately are not able to make an offer on this vehicle. You will not be charged for the valuation.
              </Text>
              {sub.declined_at ? (
                <Text style={styles.declinedMeta}>
                  {new Date(sub.declined_at).toLocaleString()}
                </Text>
              ) : null}
            </View>
          </View>
        ) : (
          <View style={styles.pendingBanner}>
            <Ionicons name="time-outline" size={20} color={colors.textSecondary} />
            <Text style={styles.pendingText}>AWAITING PRICE OFFER</Text>
          </View>
        )}

        {/* Price history log — every offer / update the admin has made, most
            recent first. Visible to both admins and the owning dealer for
            full transparency. Hidden entirely when there's no history yet. */}
        {sub.price_history && sub.price_history.length > 0 ? (
          <View style={styles.priceHistoryBox} testID="price-history">
            <Text style={styles.sectionTitle}>Offer History</Text>
            {sub.price_history
              .slice()
              .sort((a, b) => (a.at < b.at ? 1 : -1))
              .map((h, idx) => (
                <View
                  key={h.id}
                  style={[
                    styles.priceHistoryRow,
                    idx === sub.price_history!.length - 1 && { borderBottomWidth: 0 },
                  ]}
                >
                  <View style={styles.priceHistoryDot} />
                  <View style={{ flex: 1 }}>
                    <View style={styles.priceHistoryHeader}>
                      <Text style={styles.priceHistoryAction}>
                        {h.action === "update" ? "PRICE UPDATED" : "INITIAL OFFER"}
                      </Text>
                      <Text style={styles.priceHistoryDate}>
                        {new Date(h.at).toLocaleString()}
                      </Text>
                    </View>
                    <View style={styles.priceHistoryPriceRow}>
                      {h.previous_price != null ? (
                        <>
                          <Text style={styles.priceHistoryOld}>
                            {formatZAR(h.previous_price)}
                          </Text>
                          <Ionicons name="arrow-forward" size={14} color={colors.textSecondary} />
                        </>
                      ) : null}
                      <Text style={styles.priceHistoryNew}>{formatZAR(h.new_price)}</Text>
                      {h.previous_price != null ? (
                        <Text
                          style={[
                            styles.priceHistoryDelta,
                            {
                              color:
                                h.new_price > (h.previous_price || 0)
                                  ? colors.success
                                  : h.new_price < (h.previous_price || 0)
                                  ? colors.danger
                                  : colors.textSecondary,
                            },
                          ]}
                        >
                          {h.new_price > (h.previous_price || 0) ? "+" : ""}
                          {formatZAR(h.new_price - (h.previous_price || 0))}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.priceHistoryComment}>{h.comment}</Text>
                    <Text style={styles.priceHistoryAdmin}>by {h.admin_name}</Text>
                  </View>
                </View>
              ))}
          </View>
        ) : null}

        {/* Open Valuation PDF — always available once an offer has been received */}
        {sub.status === "priced" ? (
          <View style={styles.reportsSection}>
            <TouchableOpacity
              testID="download-valuation-pdf"
              style={[styles.docBtn, downloadingPdf && styles.docBtnDisabled]}
              onPress={handleDownloadPdf}
              disabled={downloadingPdf}
            >
              <View style={styles.docBtnLeft}>
                <Ionicons name="document-text-outline" size={22} color={colors.text} />
                <View style={{ marginLeft: spacing.sm, flex: 1 }}>
                  <Text style={styles.docBtnTitle}>Open Valuation PDF</Text>
                  <Text style={styles.docBtnSubtitle}>
                    Includes offer, condition, tyre estimate & any purchased reports
                  </Text>
                </View>
              </View>
              {downloadingPdf ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Ionicons name="open-outline" size={20} color={colors.text} />
              )}
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Identity */}
        <Text style={styles.sectionTitle}>Identity</Text>
        <View style={styles.detailsList}>
          <DetailRow label="VIN" value={sub.vin || "TBC"} mono />
          <DetailRow label="Engine No" value={sub.engine_number || "TBC"} mono last />
        </View>

        {/* License disk */}
        {sub.license_disk_data ? (
          <>
            <Text style={styles.sectionTitle}>License Disk Data</Text>
            {(() => {
              const info = decodeLicenseDisk(sub.license_disk_data!);
              const hasFields =
                info.vin ||
                info.make ||
                info.model ||
                info.licenceNo ||
                info.vehicleRegisterNo ||
                info.engineNo ||
                info.expiryDate ||
                info.licenceDiscNo;
              if (!hasFields) {
                return (
                  <View style={styles.diskBox}>
                    <Text style={styles.diskText}>{sub.license_disk_data}</Text>
                  </View>
                );
              }
              const rows: [string, string | undefined][] = [
                ["Licence No", info.licenceNo],
                ["Register No", info.vehicleRegisterNo],
                ["Make", info.make],
                ["Model", info.model],
                ["Colour", info.colour],
                ["Description", info.vehicleDescription],
                ["VIN", info.vin],
                ["Engine No", info.engineNo],
                ["Expires", info.expiryDate],
                ["Disc No", info.licenceDiscNo],
              ];
              return (
                <View style={styles.diskDecodedBox}>
                  {rows
                    .filter(([, v]) => !!v)
                    .map(([label, value]) => (
                      <View key={label} style={styles.diskDecodedRow}>
                        <Text style={styles.diskDecodedLabel}>{label}</Text>
                        <Text style={styles.diskDecodedValue}>{value}</Text>
                      </View>
                    ))}
                </View>
              );
            })()}
          </>
        ) : null}

        {/* Condition breakdown — 4 pillars for new submissions, legacy 3 fallback.
            HIDDEN entirely when the submission is flagged as "unseen"
            (dealer requested a desktop valuation without physical
            inspection). The red "Vehicle Unseen" banner at the top of
            the page communicates that no ratings exist. */}
        {!sub.unseen ? (
        <>
        <Text style={styles.sectionTitle}>Condition</Text>
        <View style={styles.detailsList}>
          {typeof sub.mechanical_condition === "number" ? (
            <>
              <DetailRow label="Mechanical Health" value={`${sub.mechanical_condition} / 10`} />
              <DetailRow label="Cosmetic Appearance" value={`${sub.cosmetic_condition} / 10`} />
              <DetailRow label="Interior Condition" value={`${sub.interior_condition} / 10`} />
              <DetailRow label="General Condition" value={`${sub.history_condition} / 10`} />
            </>
          ) : (
            <>
              <DetailRow label="Exterior" value={sub.exterior_condition ? `${sub.exterior_condition} / 10` : "—"} />
              <DetailRow label="Interior" value={sub.interior_condition ? `${sub.interior_condition} / 10` : "—"} />
              <DetailRow label="Tyres" value={sub.tyre_condition ? `${sub.tyre_condition} / 10` : "—"} />
            </>
          )}
          <DetailRow
            label="Previous Accident Damage"
            value={sub.accident_damage ? "Yes" : "None"}
            valueColor={sub.accident_damage ? colors.danger : colors.text}
          />
          {sub.accident_damage && sub.accident_damage_types && sub.accident_damage_types.length > 0 ? (
            <DetailRow
              label="Damage Types"
              value={sub.accident_damage_types.join(", ")}
              valueColor={colors.danger}
            />
          ) : null}
          <DetailRow
            label="Paint Evidence"
            value={sub.paint_evidence ? "Yes" : "No"}
            valueColor={sub.paint_evidence ? colors.danger : colors.text}
            last={!(sub.paint_evidence && sub.paint_quality)}
          />
          {sub.paint_evidence && sub.paint_quality ? (
            <DetailRow label="Paint Repair Quality" value={sub.paint_quality} last />
          ) : null}
        </View>

        {/* Overall condition hero — sits directly under the Condition
            breakdown per updated valuation layout. Tap to open the Condition
            Rating Guide modal. */}
        {averageRating !== null ? (
          <TouchableOpacity
            testID="avg-rating-hero"
            style={styles.heroBox}
            activeOpacity={0.85}
            onPress={() => setConditionInfoOpen(true)}
            accessibilityLabel="Tap to view condition rating guide"
          >
            <View style={styles.heroTopRow}>
              <Text style={styles.heroLabel}>OVERALL CONDITION</Text>
              <View style={styles.heroInfoBtn}>
                <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
                <Text style={styles.heroInfoText}>Guide</Text>
              </View>
            </View>
            <View style={styles.heroRow}>
              <Text style={styles.heroValue}>{averageRating.toFixed(1)}</Text>
              <Text style={styles.heroOutOf}>/ 10</Text>
            </View>
            <View style={styles.heroBar}>
              <View style={[styles.heroBarFill, { width: `${(averageRating / 10) * 100}%` }]} />
            </View>
            <View style={styles.heroBreakdown}>
              {typeof sub.mechanical_condition === "number" ? (
                <>
                  <HeroPill label="MECH" value={sub.mechanical_condition} />
                  <HeroPill label="COSM" value={sub.cosmetic_condition} />
                  <HeroPill label="INT" value={sub.interior_condition} />
                  <HeroPill label="GEN" value={sub.history_condition} />
                </>
              ) : (
                <>
                  <HeroPill label="EXT" value={sub.exterior_condition} />
                  <HeroPill label="INT" value={sub.interior_condition} />
                  <HeroPill label="TYRES" value={sub.tyre_condition} />
                </>
              )}
            </View>
          </TouchableOpacity>
        ) : null}
        </>
        ) : null}
        {/* --- end !sub.unseen : Condition section --- */}

        {/* Reconditioning */}
        {!sub.unseen && sub.reconditioning_items && sub.reconditioning_items.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Reconditioning Estimate</Text>
            <View style={styles.detailsList}>
              {sub.reconditioning_items.map((r, i) => {
                // Support both new multi-photo and legacy single-photo shapes.
                const photos: string[] = Array.isArray(r.photos) && r.photos.length > 0
                  ? (r.photos as string[])
                  : r.photo
                    ? [r.photo]
                    : [];
                const heading = r.category || r.label || "Reconditioning";
                return (
                  <View key={i} style={styles.reconCardRow}>
                    <View style={styles.reconHeadRow}>
                      <Text style={styles.reconLabel}>{heading}</Text>
                      <Text style={styles.reconAmount}>R {r.amount_zar.toLocaleString()}</Text>
                    </View>
                    {photos.length > 0 ? (
                      <View style={styles.reconPhotoStripDetail}>
                        {photos.map((uri, pIdx) => (
                          <TouchableOpacity
                            key={pIdx}
                            onPress={() => {
                              const idx = carouselPhotos.findIndex((c) => c.uri === uri);
                              if (idx >= 0) setCarouselIdx(idx);
                            }}
                            style={styles.reconThumbWrap}
                            testID={`recon-thumb-${i}-${pIdx}`}
                          >
                            <Image source={{ uri }} style={styles.reconThumb} />
                          </TouchableOpacity>
                        ))}
                      </View>
                    ) : null}
                  </View>
                );
              })}
              <View style={styles.reconTotalRow}>
                <Text style={styles.reconTotalLabel}>TOTAL</Text>
                <Text style={styles.reconTotalValue}>
                  R {(sub.reconditioning_total_zar ?? sub.reconditioning_items.reduce((s, x) => s + (x.amount_zar || 0), 0)).toLocaleString()}
                </Text>
              </View>
            </View>
          </>
        ) : null}

        {/* Service history — hidden when the submission is flagged as
            "unseen" (dealer didn't inspect the vehicle). */}
        {!sub.unseen && sub.service_history ? (
          <>
            <Text style={styles.sectionTitle}>Service History</Text>
            <View style={styles.detailsList}>
              <DetailRow label="History" value={sub.service_history} />
              <DetailRow
                label="Last Service"
                value={sub.last_service_date && sub.last_service_date !== "TBC" ? sub.last_service_date : "TBC"}
              />
              <DetailRow
                label="Service Mileage"
                value={sub.last_service_mileage ? `${sub.last_service_mileage.toLocaleString()} km` : "TBC"}
              />
              {(() => {
                // Derived "gap since last service" — helps admins pricing older/
                // deferred maintenance quickly. Time & mileage overdue trigger
                // colour-coded warnings (amber >12m or >15,000 km; red >24m or
                // >30,000 km).
                const gap = computeServiceGap(
                  sub.last_service_date,
                  sub.last_service_mileage,
                  sub.mileage,
                );
                if (gap.monthsAgo == null && gap.kmSince == null) return null;
                const timeColour =
                  gap.monthsAgo != null && gap.monthsAgo >= 24
                    ? colors.danger
                    : gap.monthsAgo != null && gap.monthsAgo >= 12
                    ? colors.warning
                    : colors.success;
                const kmColour =
                  gap.kmSince != null && gap.kmSince >= 30000
                    ? colors.danger
                    : gap.kmSince != null && gap.kmSince >= 15000
                    ? colors.warning
                    : colors.success;
                return (
                  <>
                    <DetailRow
                      label="Time Since Service"
                      value={gap.monthsAgo != null ? formatMonthsAgo(gap.monthsAgo) : "—"}
                      valueColor={timeColour}
                    />
                    <DetailRow
                      label="Mileage Since Service"
                      value={gap.kmSince != null ? formatKm(gap.kmSince) : "—"}
                      valueColor={kmColour}
                      last
                    />
                  </>
                );
              })()}
            </View>
          </>
        ) : null}

        {/* Warranty & Maintenance Plan — dealer answer at valuation stage */}
        {!sub.unseen && (sub.factory_warranty_status || sub.maintenance_plan_status || sub.factory_warranty !== undefined) ? (
          <>
            <Text style={styles.sectionTitle}>Warranty &amp; Maintenance Plan</Text>
            <View style={styles.detailsList}>
              {(() => {
                const fwStatus = sub.factory_warranty_status
                  || (sub.factory_warranty === true ? "active" : sub.factory_warranty === false ? "expired" : null);
                const label = (v: string | null | undefined) =>
                  v === "active" ? "Active" : v === "expired" ? "Expired" : "Not answered";
                const colour = (v: string | null | undefined) =>
                  v === "active" ? colors.success : v === "expired" ? colors.danger : colors.textSecondary;
                return (
                  <>
                    <DetailRow
                      label="Factory Warranty"
                      value={label(fwStatus)}
                      valueColor={colour(fwStatus)}
                    />
                    <DetailRow
                      label="Maintenance Plan"
                      value={label(sub.maintenance_plan_status)}
                      valueColor={colour(sub.maintenance_plan_status)}
                      last
                    />
                  </>
                );
              })()}
            </View>
          </>
        ) : null}

        {/* AI Market Analysis */}
        <View style={styles.analysisHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionTitle}>AI Market Analysis</Text>
            {sub.market_analysis?.generated_at ? (
              <Text style={styles.analysisTs}>
                Generated {new Date(sub.market_analysis.generated_at).toLocaleString()}
              </Text>
            ) : null}
          </View>
          <TouchableOpacity
            testID="market-analysis-button"
            style={[styles.analysisBtn, analysing && { opacity: 0.6 }]}
            onPress={handleMarketAnalysis}
            disabled={analysing}
          >
            {analysing ? (
              <ActivityIndicator color={colors.primary} size="small" />
            ) : (
              <>
                <Ionicons name="sparkles" size={14} color={colors.primary} />
                <Text style={styles.analysisBtnText}>
                  {sub.market_analysis ? "Refresh" : "Analyse"}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {sub.market_analysis?.analysis ? (
          <View style={styles.analysisCard} testID="market-analysis-card">
            {sub.market_analysis.analysis.estimated_market_range_zar ? (
              <View style={styles.rangeBox}>
                <View style={styles.rangeCol}>
                  <Text style={styles.rangeLabel}>LOW</Text>
                  <Text style={styles.rangeValue}>
                    R {sub.market_analysis.analysis.estimated_market_range_zar.low.toLocaleString()}
                  </Text>
                </View>
                <View style={[styles.rangeCol, styles.rangeColMid]}>
                  <Text style={styles.rangeLabel}>TYPICAL</Text>
                  <Text style={styles.rangeValue}>
                    R {sub.market_analysis.analysis.estimated_market_range_zar.typical.toLocaleString()}
                  </Text>
                </View>
                <View style={styles.rangeCol}>
                  <Text style={styles.rangeLabel}>HIGH</Text>
                  <Text style={styles.rangeValue}>
                    R {sub.market_analysis.analysis.estimated_market_range_zar.high.toLocaleString()}
                  </Text>
                </View>
              </View>
            ) : null}

            <View style={styles.tradeRow}>
              {sub.market_analysis.analysis.trade_price_estimate_zar ? (
                <View style={styles.tradeCol}>
                  <Text style={styles.tradeLabel}>Trade Estimate</Text>
                  <Text style={styles.tradeValue}>
                    R {sub.market_analysis.analysis.trade_price_estimate_zar.toLocaleString()}
                  </Text>
                </View>
              ) : null}
              {sub.market_analysis.analysis.retail_price_estimate_zar ? (
                <View style={styles.tradeCol}>
                  <Text style={styles.tradeLabel}>Retail Estimate</Text>
                  <Text style={styles.tradeValue}>
                    R {sub.market_analysis.analysis.retail_price_estimate_zar.toLocaleString()}
                  </Text>
                </View>
              ) : null}
            </View>

            {sub.market_analysis.analysis.listings_summary ? (
              <Text style={styles.summary}>{sub.market_analysis.analysis.listings_summary}</Text>
            ) : null}

            {sub.market_analysis.analysis.key_factors?.length ? (
              <View style={styles.factorsBox}>
                <Text style={styles.factorsTitle}>KEY FACTORS</Text>
                {sub.market_analysis.analysis.key_factors.map((f, i) => (
                  <View key={i} style={styles.factorRow}>
                    <Ionicons name="checkmark-circle" size={14} color={colors.primary} />
                    <Text style={styles.factorText}>{f}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {sub.market_analysis.analysis.kredo_alignment ? (
              <View style={styles.factorsBox}>
                <Text style={styles.factorsTitle}>KREDO ALIGNMENT</Text>
                <Text style={styles.factorText}>
                  {sub.market_analysis.analysis.kredo_alignment}
                </Text>
              </View>
            ) : null}

            {sub.market_analysis.analysis.recon_impact_zar ? (
              <Text style={styles.confidence}>
                Recon adjustment: −R {sub.market_analysis.analysis.recon_impact_zar.toLocaleString()}
              </Text>
            ) : null}

            {sub.market_analysis.analysis.confidence ? (
              <Text style={styles.confidence}>
                Confidence: {sub.market_analysis.analysis.confidence.toUpperCase()}
              </Text>
            ) : null}

            {sub.market_analysis.analysis.raw ? (
              <Text style={styles.summary}>{sub.market_analysis.analysis.raw}</Text>
            ) : null}

            {sub.market_analysis.analysis.disclaimer ? (
              <Text style={styles.disclaimer}>{sub.market_analysis.analysis.disclaimer}</Text>
            ) : null}
          </View>
        ) : (
          <View style={styles.analysisEmpty}>
            <Ionicons name="analytics-outline" size={20} color={colors.textSecondary} />
            <Text style={styles.analysisEmptyText}>
              Tap Analyse for a GPT-5.2 market overview comparing this car against typical
              autotrader.co.za and cars.co.za listings.
            </Text>
          </View>
        )}

        {/* Tyre Replacement Estimate — admin-only */}
        {isAdmin ? (
          <>
            <View style={styles.analysisHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle}>Tyre Replacement Estimate</Text>
                {sub.tyre_estimate?.generated_at ? (
                  <Text style={styles.analysisTs}>
                    Generated {new Date(sub.tyre_estimate.generated_at).toLocaleString()}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity
                testID="tyre-estimate-button"
                style={[styles.analysisBtn, estimatingTyres && { opacity: 0.6 }]}
                onPress={handleTyreEstimate}
                disabled={estimatingTyres}
              >
                {estimatingTyres ? (
                  <ActivityIndicator color={colors.primary} size="small" />
                ) : (
                  <>
                    <Ionicons name="disc-outline" size={14} color={colors.primary} />
                    <Text style={styles.analysisBtnText}>
                      {sub.tyre_estimate ? "Refresh" : "Estimate"}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {sub.tyre_estimate?.estimate ? (
              <View style={styles.analysisCard} testID="tyre-estimate-card">
                <View style={styles.tyreHeaderRow}>
                  <View style={styles.tyreSpecBadge}>
                    <Ionicons name="disc" size={14} color="#fff" />
                    <Text style={styles.tyreSpecText}>
                      {sub.tyre_estimate.estimate.tyre_spec ?? "—"}
                    </Text>
                  </View>
                </View>

                {sub.tyre_estimate.estimate.total_replacement_estimate_zar ? (
                  <View style={styles.tyreTotalBox}>
                    <Text style={styles.tyreTotalLabel}>Total 4-tyre replacement</Text>
                    <Text style={styles.tyreTotalValue}>
                      R {sub.tyre_estimate.estimate.total_replacement_estimate_zar.toLocaleString()}
                    </Text>
                  </View>
                ) : null}

                {sub.tyre_estimate.estimate.set_of_four_zar ? (
                  <View style={styles.rangeBox}>
                    <View style={styles.rangeCol}>
                      <Text style={styles.rangeLabel}>SET LOW</Text>
                      <Text style={styles.rangeValue}>
                        R {sub.tyre_estimate.estimate.set_of_four_zar.low.toLocaleString()}
                      </Text>
                    </View>
                    <View style={[styles.rangeCol, styles.rangeColMid]}>
                      <Text style={styles.rangeLabel}>TYPICAL</Text>
                      <Text style={styles.rangeValue}>
                        R {sub.tyre_estimate.estimate.set_of_four_zar.typical.toLocaleString()}
                      </Text>
                    </View>
                    <View style={styles.rangeCol}>
                      <Text style={styles.rangeLabel}>SET HIGH</Text>
                      <Text style={styles.rangeValue}>
                        R {sub.tyre_estimate.estimate.set_of_four_zar.high.toLocaleString()}
                      </Text>
                    </View>
                  </View>
                ) : null}

                <View style={styles.tradeRow}>
                  {sub.tyre_estimate.estimate.per_tyre_range_zar ? (
                    <View style={styles.tradeCol}>
                      <Text style={styles.tradeLabel}>Per tyre (typical)</Text>
                      <Text style={styles.tradeValue}>
                        R {sub.tyre_estimate.estimate.per_tyre_range_zar.typical.toLocaleString()}
                      </Text>
                    </View>
                  ) : null}
                  {sub.tyre_estimate.estimate.fitment_and_balance_zar ? (
                    <View style={styles.tradeCol}>
                      <Text style={styles.tradeLabel}>Fitment & balance</Text>
                      <Text style={styles.tradeValue}>
                        R {sub.tyre_estimate.estimate.fitment_and_balance_zar.toLocaleString()}
                      </Text>
                    </View>
                  ) : null}
                </View>

                {sub.tyre_estimate.estimate.recommended_brands?.length ? (
                  <View style={styles.factorsBox}>
                    <Text style={styles.factorsTitle}>RECOMMENDED BRANDS</Text>
                    {sub.tyre_estimate.estimate.recommended_brands.map((b, i) => (
                      <View key={i} style={styles.factorRow}>
                        <Ionicons name="checkmark-circle" size={14} color={colors.primary} />
                        <Text style={styles.factorText}>{b}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}

                {sub.tyre_estimate.estimate.notes ? (
                  <Text style={styles.summary}>{sub.tyre_estimate.estimate.notes}</Text>
                ) : null}

                {sub.tyre_estimate.estimate.confidence ? (
                  <Text style={styles.confidence}>
                    Confidence: {sub.tyre_estimate.estimate.confidence.toUpperCase()}
                  </Text>
                ) : null}

                {sub.tyre_estimate.estimate.raw ? (
                  <Text style={styles.summary}>{sub.tyre_estimate.estimate.raw}</Text>
                ) : null}

                {sub.tyre_estimate.estimate.disclaimer ? (
                  <Text style={styles.disclaimer}>{sub.tyre_estimate.estimate.disclaimer}</Text>
                ) : null}
              </View>
            ) : (
              <View style={styles.analysisEmpty}>
                <Ionicons name="disc-outline" size={20} color={colors.textSecondary} />
                <Text style={styles.analysisEmptyText}>
                  Tap Estimate for a GPT-5.2 tyre-replacement price based on this vehicle&apos;s
                  OEM tyre spec and current SA aftermarket pricing.
                </Text>
              </View>
            )}
          </>
        ) : null}

        {/* VIN-linked Reports — order or view */}
        {sub.status === "priced" ? (
          <View style={styles.reportsSection} testID="reports-section">
            <Text style={styles.sectionTitle}>Order a VIN-Linked Report</Text>
        {/* VIN-linked report ordering — only when a VIN was entered/scanned.
                Admins never see the "Order" buttons: they can only view reports
                the dealer has already ordered. */}
            {sub.vin && sub.vin.trim() && sub.vin.toUpperCase() !== "TBC" ? (
              <>
                {isAdmin ? (
                  // Admin: hide the order UI. Show ordered reports (if any) or a
                  // small hint that the dealer hasn't purchased any yet.
                  (sub.report_orders || []).length > 0 ? (
                    <>
                      <Text style={styles.reportsSubhead}>VIN reports ordered by dealer</Text>
                      <Text style={styles.reportsHelp}>
                        Verified against VIN {sub.vin}. Admins can view results but cannot order reports on behalf of a dealer.
                      </Text>
                    </>
                  ) : (
                    <View style={styles.adminNoReports}>
                      <Ionicons name="lock-closed-outline" size={16} color={colors.textDisabled} />
                      <Text style={styles.adminNoReportsText}>
                        VIN reports can only be ordered by the dealer. None purchased yet.
                      </Text>
                    </View>
                  )
                ) : (
                  <>
                    <Text style={styles.reportsSubhead}>Order a VIN-linked report</Text>
                    <Text style={styles.reportsHelp}>
                      Reports are verified against VIN {sub.vin}. The charge will be added to your next invoice.
                    </Text>
                  </>
                )}

                {((): ReportOrder["type"][] => {
                    const baseTypes: ReportOrder["type"][] = [
                      "lightstone_verification",
                      "lightstone_repair",
                      "car_vertical",
                    ];
                    // BMW factory options is BMW-group only — filter on the
                    // submission's make so it never appears on other brands.
                    if (isBimmerSupported) baseTypes.push("bmw_options");
                    // JLR OSH service history is JLR-only.
                    if (isLandroverSupported) baseTypes.push("landrover_osh");
                    return baseTypes;
                  })()
                  .filter((t) => !isAdmin || orderedReportTypes.has(t))
                  .map((t) => {
                    const meta = REPORT_CATALOG[t];
                    const alreadyOrdered = orderedReportTypes.has(t);
                    const existing = (sub.report_orders || []).find((r) => r.type === t);
                    const busy = orderingReportType === t;
                    const isDelivered = existing?.status === "delivered";
                    return (
                      <View key={t} style={styles.reportCard}>
                        <View style={{ flex: 1, marginRight: spacing.sm }}>
                          <Text style={styles.reportName}>{meta.name}</Text>
                          <Text style={styles.reportCost}>R{meta.cost_zar.toFixed(0)}</Text>
                          {alreadyOrdered ? (
                            <View style={styles.reportStatusRow}>
                              <View
                                style={[
                                  styles.statusPill,
                                  isDelivered ? styles.statusPillOk : styles.statusPillPending,
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.statusPillText,
                                    isDelivered
                                      ? { color: colors.success }
                                      : { color: colors.warning },
                                  ]}
                                >
                                  {(existing?.status || "pending").toUpperCase()}
                                </Text>
                              </View>
                              {!isDelivered ? (
                                <Text style={styles.reportPendingNote} numberOfLines={2}>
                                  {existing?.note ||
                                    "Awaiting API integration — result will appear here once the provider responds."}
                                </Text>
                              ) : null}
                            </View>
                          ) : null}
                        </View>
                        {alreadyOrdered ? (
                          isDelivered ? (
                            <TouchableOpacity
                              testID={`view-report-${t}`}
                              style={styles.viewReportBtn}
                              onPress={() => setViewingReport(existing || null)}
                            >
                              <Ionicons name="eye-outline" size={16} color={colors.onPrimary} />
                              <Text style={styles.viewReportBtnText}>View</Text>
                            </TouchableOpacity>
                          ) : (
                            <View style={styles.reportOrderedBadge}>
                              <Ionicons name="checkmark" size={16} color={colors.text} />
                              <Text style={styles.reportOrderedBadgeText}>Ordered</Text>
                            </View>
                          )
                        ) : (
                          <TouchableOpacity
                            testID={`order-report-${t}`}
                            style={[styles.orderBtn, busy && styles.docBtnDisabled]}
                            onPress={() =>
                              setConfirmReport({ type: t, name: meta.name, cost_zar: meta.cost_zar })
                            }
                            disabled={busy}
                          >
                            {busy ? (
                              <ActivityIndicator color={colors.onPrimary} size="small" />
                            ) : (
                              <Text style={styles.orderBtnText}>Order</Text>
                            )}
                          </TouchableOpacity>
                        )}
                      </View>
                    );
                  })}

                {/* Kredo CarTrust report — treated like any other VIN-linked
                    report, but with its own async pending/completed flow
                    (see orderCartrust / cartrust state above). Available to
                    both admins and dealers; admins can order/refresh. */}
                {(
                  <View style={styles.reportCard} testID="cartrust-card">
                    <View style={{ flex: 1, marginRight: spacing.sm }}>
                      <Text style={styles.reportName}>{REPORT_CATALOG.kredo_cartrust.name}</Text>
                      <Text style={styles.reportCost}>R{REPORT_CATALOG.kredo_cartrust.cost_zar.toFixed(0)}</Text>
                      {cartrust ? (
                        <View style={styles.reportStatusRow}>
                          <View
                            style={[
                              styles.statusPill,
                              cartrust.status === "completed"
                                ? styles.statusPillOk
                                : styles.statusPillPending,
                            ]}
                          >
                            <Text
                              style={[
                                styles.statusPillText,
                                cartrust.status === "completed"
                                  ? styles.statusPillTextOk
                                  : styles.statusPillTextPending,
                              ]}
                            >
                              {cartrust.status.toUpperCase()}
                            </Text>
                          </View>
                          <Text style={styles.reportStatusMeta}>
                            {cartrust.status === "pending"
                              ? "Kredo is preparing your report…"
                              : cartrust.status === "completed"
                              ? "Ready to view"
                              : (cartrust.error || "Please try again")}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    {cartrust?.status === "completed" ? (
                      <TouchableOpacity
                        testID="cartrust-view-btn"
                        style={styles.viewReportBtn}
                        onPress={openCartrust}
                      >
                        <Ionicons name="eye-outline" size={16} color={colors.onPrimary} />
                        <Text style={styles.viewReportBtnText}>View</Text>
                      </TouchableOpacity>
                    ) : cartrust?.status === "pending" ? (
                      <View style={styles.reportOrderedBadge}>
                        <ActivityIndicator color={colors.text} size="small" />
                        <Text style={styles.reportOrderedBadgeText}>Ordered</Text>
                      </View>
                    ) : (
                      <TouchableOpacity
                        testID="cartrust-order-btn"
                        style={[styles.orderBtn, cartrustLoading && styles.docBtnDisabled]}
                        onPress={() =>
                          setConfirmReport({
                            type: "kredo_cartrust" as ReportOrder["type"],
                            name: REPORT_CATALOG.kredo_cartrust.name,
                            cost_zar: REPORT_CATALOG.kredo_cartrust.cost_zar,
                          })
                        }
                        disabled={cartrustLoading}
                      >
                        {cartrustLoading ? (
                          <ActivityIndicator color={colors.onPrimary} size="small" />
                        ) : (
                          <Text style={styles.orderBtnText}>Order</Text>
                        )}
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </>
            ) : null}
          </View>
        ) : null}

        {/* CarTrust PDF ordering is now rendered inline in the "Order a
            VIN-Linked Report" section above — the standalone card was
            removed at the user's request. */}

        {/* Kredo VIN accident/claim history — available to both admins
            and dealers. Admins fetch for free; dealers pay a per-fetch
            R100 charge that goes onto their next invoice. Cache hits are
            free — the R100 is billed exactly once per submission. */}
        {sub.vin && sub.vin.trim() && sub.vin.toUpperCase() !== "TBC" ? (
          <View style={styles.reportsSection} testID="kredo-history-section">
            <Text style={styles.sectionTitle}>Accident / Claim History</Text>
            <Text style={styles.reportsHelp}>
              {isAdmin
                ? `Kredo VIN history for ${sub.vin}. Results are cached — refresh only if you need a fresh check.`
                : `Live Kredo VIN check for ${sub.vin}. R${KREDO_VIN_HISTORY_DEALER_COST_ZAR} per lookup, billed to your next invoice. Cache hits are free.`}
            </Text>

            <TouchableOpacity
              testID="kredo-history-fetch-btn"
              style={[
                styles.kredoFetchBtn,
                kredoLoading && styles.kredoFetchBtnDisabled,
              ]}
              onPress={() => fetchKredoHistory(!!kredoHistory)}
              disabled={kredoLoading}
              accessibilityRole="button"
              accessibilityLabel={kredoHistory ? "Refresh accident history" : "Fetch accident history"}
            >
              {kredoLoading ? (
                <ActivityIndicator color={colors.onPrimary} size="small" />
              ) : (
                <>
                  <Ionicons
                    name={kredoHistory ? "refresh" : "search"}
                    size={16}
                    color={colors.onPrimary}
                  />
                  <Text style={styles.kredoFetchBtnText}>
                    {kredoHistory ? "Refresh Accident History" : "Fetch Accident History"}
                  </Text>
                </>
              )}
            </TouchableOpacity>

            {!kredoHistory ? (
              <View style={styles.kredoEmpty}>
                <Ionicons name="alert-circle-outline" size={22} color={colors.textDisabled} />
                <Text style={styles.kredoEmptyText}>
                  No history fetched yet. Tap Fetch to check for insurance claims and accident records for this VIN.
                </Text>
              </View>
            ) : kredoHistory.result.claim_count === 0 ? (
              <View style={styles.kredoClean}>
                <Ionicons name="checkmark-circle" size={22} color={colors.success} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.kredoCleanTitle}>No claims found</Text>
                  <Text style={styles.kredoCleanSub}>
                    Kredo has no insurance-claim records against this VIN.
                    {kredoHistory.cached_at ? ` · Checked ${new Date(kredoHistory.cached_at).toLocaleString()}` : ""}
                  </Text>
                </View>
              </View>
            ) : (
              <View>
                <View style={styles.kredoCountBanner}>
                  <Ionicons name="warning" size={16} color={colors.warning} />
                  <Text style={styles.kredoCountText}>
                    {kredoHistory.result.claim_count} claim{kredoHistory.result.claim_count === 1 ? "" : "s"} on record
                  </Text>
                  <Text style={styles.kredoSource}>
                    {kredoHistory.source === "cache" ? "cached" : "live"}
                    {kredoHistory.cached_at ? ` · ${new Date(kredoHistory.cached_at).toLocaleDateString()}` : ""}
                  </Text>
                </View>
                {kredoHistory.result.claims.map((c) => (
                  <View key={c.id} style={styles.claimCard}>
                    <View style={styles.claimHead}>
                      <Text style={styles.claimDate}>
                        {c.accident_date || c.creation_date || "Unknown date"}
                      </Text>
                      {c.country ? <Text style={styles.claimCountry}>{c.country}</Text> : null}
                    </View>
                    {c.manufacturer || c.model ? (
                      <Text style={styles.claimVehicle}>
                        {[c.manufacturer, c.model].filter(Boolean).join(" · ")}
                      </Text>
                    ) : null}
                    {c.mileage_at_claim ? (
                      <Text style={styles.claimMeta}>
                        {parseInt(c.mileage_at_claim, 10).toLocaleString("en-ZA")} km at claim
                      </Text>
                    ) : null}
                    {c.damage_locations.length > 0 ? (
                      <View style={styles.damageRow}>
                        {c.damage_locations.map((d) => (
                          <View key={d} style={styles.damageChip}>
                            <Text style={styles.damageChipText}>{d.replace("-", " ").toUpperCase()}</Text>
                          </View>
                        ))}
                        {c.glass_damage ? (
                          <View style={[styles.damageChip, styles.damageChipGlass]}>
                            <Ionicons name="glasses-outline" size={10} color={colors.onPrimary} />
                            <Text style={[styles.damageChipText, { color: colors.onPrimary }]}>WINDSCREEN</Text>
                          </View>
                        ) : null}
                      </View>
                    ) : (
                      <Text style={styles.claimMeta}>
                        Claim record present but no specific damage location recorded.
                      </Text>
                    )}
                    <Text style={styles.claimId}>Ref: {c.id}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        ) : null}

        {/* Dealer info for admin */}
        {isAdmin && sub.dealer_name ? (
          // Submitted By is rendered near the top of the page (right after
          // the reference badge). Keeping this placeholder here so the
          // component tree remains stable during future edits.
          null
        ) : null}

        {/* Admin pricing actions — moved from the floating footer down to
            the bottom of the scroll content per user request, so admins
            scroll through the full submission before making an offer. */}

        {/* Kredo Vehicle Values — new list, M&M code, trade + retail. Cached
            per-submission on first view; both admins and dealers can refresh. */}
        <Text style={styles.sectionTitle}>Market Values</Text>
        <View style={styles.marketValuesCard} testID="market-values-card">
          {marketValues?.status === "ok" ? (
            <>
              <View style={styles.marketRow}>
                <Text style={styles.marketLabel}>New List Price</Text>
                <Text style={styles.marketValue} testID="mv-new-list">
                  {formatMV(marketValues.new_list_price_zar)}
                </Text>
              </View>
              <View style={styles.marketRow}>
                <Text style={styles.marketLabel}>M&M Code</Text>
                <View style={{ alignItems: "flex-end" }}>
                  <Text
                    style={[styles.marketValue, { fontFamily: fonts.mono, letterSpacing: 0.5 }]}
                    testID="mv-mm-code"
                  >
                    {marketValues.mm_code || "—"}
                  </Text>
                  {!marketValues.mm_code ? (
                    <Text style={styles.marketHint}>Not returned by Kredo Vehicle Values</Text>
                  ) : null}
                </View>
              </View>
              <View style={styles.marketRow}>
                <Text style={styles.marketLabel}>Trade Value</Text>
                <Text style={styles.marketValue} testID="mv-trade">
                  {formatMV(marketValues.trade_price_zar)}
                </Text>
              </View>
              <View style={[styles.marketRow, { borderBottomWidth: 0 }]}>
                <Text style={styles.marketLabel}>Retail Value</Text>
                <Text style={styles.marketValue} testID="mv-retail">
                  {formatMV(marketValues.retail_price_zar)}
                </Text>
              </View>
              <View style={styles.marketFooter}>
                <Text style={styles.marketFooterText}>
                  Source: Kredo Vehicle Values
                  {marketValues.fetched_at ? ` · captured ${formatFetched(marketValues.fetched_at)}` : ""}
                </Text>
                <View style={styles.marketLockedPill} testID="market-values-locked">
                  <Ionicons name="lock-closed" size={12} color={colors.textSecondary} />
                  <Text style={styles.marketLockedText}>Locked at valuation</Text>
                </View>
              </View>
            </>
          ) : marketValues?.status === "error" ? (
            <View style={styles.marketErrorBox}>
              <Ionicons name="alert-circle-outline" size={18} color={colors.warning} />
              <View style={{ flex: 1 }}>
                <Text style={styles.marketErrorText}>Could not fetch market values.</Text>
                <Text style={styles.marketErrorDetail} numberOfLines={3}>
                  {marketValues.error || "The Kredo Vehicle Values lookup failed."}
                </Text>
              </View>
              <TouchableOpacity
                testID="market-values-retry"
                onPress={refreshMarketValues}
                disabled={marketValuesLoading}
                style={[styles.marketRefreshBtn, marketValuesLoading && styles.docBtnDisabled]}
              >
                {marketValuesLoading ? (
                  <ActivityIndicator size="small" color={colors.text} />
                ) : (
                  <Text style={styles.marketRefreshText}>Retry</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.marketLoadingBox}>
              <ActivityIndicator size="small" color={colors.text} />
              <Text style={styles.marketLoadingText}>Fetching from Kredo…</Text>
            </View>
          )}
        </View>

        {/* NOTE: BMW factory options used to have its own admin-only card
            here. It has been moved into "Order a VIN-Linked Report" below
            so any dealer with a BMW-group vehicle can purchase the R10
            factory-options lookup like any other VIN report. The result
            still gets cached on `submission.bimmer_spec` so the valuation
            PDF continues to include it. */}

        {isAdmin ? (
          <>
            <Text style={styles.sectionTitle}>Admin Pricing</Text>
            <View style={styles.adminActionBox} testID="admin-pricing-inline">
              {sub.status === "priced" && sub.price != null ? (
                <View style={styles.adminCurrentPrice}>
                  <Text style={styles.adminCurrentPriceLabel}>CURRENT OFFER</Text>
                  <Text style={styles.adminCurrentPriceValue}>{formatZAR(sub.price)}</Text>
                </View>
              ) : null}
              <TouchableOpacity
                testID="offer-price-button"
                style={styles.priceBtn}
                onPress={() => {
                  setPriceInput(sub.price ? String(sub.price) : "");
                  setNotesInput(sub.price_notes || "");
                  setChangeCommentInput("");
                  setPriceModal(true);
                }}
              >
                <Ionicons name="pricetag" size={18} color={colors.onPrimary} />
                <Text style={styles.priceBtnText}>
                  {sub.status === "priced" ? "Update Price" : "Offer Price"}
                </Text>
              </TouchableOpacity>
              {sub.status !== "priced" ? (
                <TouchableOpacity
                  testID="decline-offer-button"
                  style={styles.declineBtn}
                  onPress={() => setDeclineModal(true)}
                  disabled={declining}
                >
                  {declining ? (
                    <ActivityIndicator color={colors.text} />
                  ) : (
                    <>
                      <Ionicons name="close-circle-outline" size={18} color={colors.text} />
                      <Text style={styles.declineBtnText}>
                        {sub.status === "declined" ? "Declined" : "Cannot Offer"}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              ) : null}
            </View>
          </>
        ) : null}
      </ScrollView>

      {/* Floating footer removed — pricing is now inline at the bottom
          of the scroll content. */}

      {/* Price modal */}
      <Modal visible={priceModal} transparent animationType="slide" onRequestClose={() => setPriceModal(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPriceModal(false)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {sub.status === "priced" ? "Update Price" : "Offer Price"}
              </Text>
              <TouchableOpacity testID="price-modal-close" onPress={() => setPriceModal(false)}>
                <Ionicons name="close" size={22} color={colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalHint}>
              {sub.year} {sub.make_name} {sub.model_name}
            </Text>
            {sub.status === "priced" && sub.price != null ? (
              <Text style={[styles.modalHint, { marginTop: 2 }]}>
                Previous offer: <Text style={{ color: colors.text, fontWeight: "700" }}>{formatZAR(sub.price)}</Text>
              </Text>
            ) : null}
            <Text style={styles.label}>Price (ZAR)</Text>
            <TextInput
              testID="price-input"
              style={styles.priceInput}
              value={priceInput}
              onChangeText={setPriceInput}
              placeholder="0"
              placeholderTextColor={colors.textDisabled}
              keyboardType="numeric"
              autoFocus
            />
            <Text style={styles.label}>Notes (optional, shown to dealer)</Text>
            <TextInput
              testID="notes-input"
              style={[styles.priceInput, { height: 60 }]}
              value={notesInput}
              onChangeText={setNotesInput}
              placeholder="e.g. Trade price offer valid 7 days"
              placeholderTextColor={colors.textDisabled}
              multiline
            />
            <Text style={styles.label}>
              Change comment (optional — reason for {sub.status === "priced" ? "the update" : "this offer"})
            </Text>
            <TextInput
              testID="change-comment-input"
              style={[styles.priceInput, { height: 60 }]}
              value={changeCommentInput}
              onChangeText={setChangeCommentInput}
              placeholder={
                sub.status === "priced"
                  ? "e.g. Adjusted for higher mileage; matched new market comps"
                  : "e.g. Initial offer based on average trade condition"
              }
              placeholderTextColor={colors.textDisabled}
              multiline
            />
            <TouchableOpacity
              testID="confirm-price-button"
              style={[styles.confirmBtn, submittingPrice && { opacity: 0.6 }]}
              onPress={handleOfferPrice}
              disabled={submittingPrice}
            >
              {submittingPrice ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.confirmBtnText}>
                  {sub.status === "priced" ? "Confirm Update" : "Confirm Price"}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Decline confirmation modal — admin cannot offer on this vehicle */}
      <Modal
        visible={declineModal}
        transparent
        animationType="fade"
        onRequestClose={() => (declining ? null : setDeclineModal(false))}
      >
        <View style={styles.reportModalBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => (declining ? null : setDeclineModal(false))}
          />
          <View style={styles.reportModalCard}>
            <View style={styles.reportModalHeader}>
              <Ionicons name="close-circle-outline" size={22} color={colors.text} />
              <Text style={styles.reportModalTitle}>Cannot Offer</Text>
            </View>
            <Text style={styles.reportModalReport}>
              {sub.year} {sub.make_name} {sub.model_name}
            </Text>
            <Text style={[styles.reportModalBody, { marginTop: spacing.sm }]}>
              This dealer will be notified:
            </Text>
            <View style={styles.declineQuote}>
              <Text style={styles.declineQuoteText}>
                “We unfortunately are not able to make an offer on this vehicle,
                you will not be charged for the valuation.”
              </Text>
            </View>
            <Text style={styles.reportModalBodySmall}>
              The dealer will not be charged the R{50} valuation fee for this submission.
            </Text>

            <Text style={styles.label}>Internal note (optional — not shown to dealer)</Text>
            <TextInput
              testID="decline-note-input"
              style={[styles.priceInput, { minHeight: 64, textAlignVertical: "top" }]}
              value={declineNote}
              onChangeText={setDeclineNote}
              placeholder="e.g. VIN mismatch, out-of-scope model, etc."
              placeholderTextColor={colors.textDisabled}
              multiline
            />

            <View style={styles.reportModalActions}>
              <TouchableOpacity
                testID="decline-cancel"
                style={styles.reportModalCancel}
                onPress={() => setDeclineModal(false)}
                disabled={declining}
              >
                <Text style={styles.reportModalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="decline-confirm"
                style={[
                  styles.reportModalConfirm,
                  declining && styles.docBtnDisabled,
                ]}
                onPress={handleDeclineOffer}
                disabled={declining}
              >
                {declining ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.reportModalConfirmText}>Confirm Decline</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Fullscreen photo carousel */}
      <PhotoCarousel
        photos={carouselPhotos}
        initialIndex={carouselIdx ?? 0}
        visible={carouselIdx !== null}
        onClose={() => setCarouselIdx(null)}
      />

      {/* Condition rating breakdown modal */}
      <ConditionRatingInfoModal
        visible={conditionInfoOpen}
        onClose={() => setConditionInfoOpen(false)}
      />

      {/* Report order confirmation modal */}
      <Modal
        visible={confirmReport !== null}
        transparent
        animationType="fade"
        onRequestClose={() => (orderingReportType ? null : setConfirmReport(null))}
      >
        <View style={styles.reportModalBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => (orderingReportType ? null : setConfirmReport(null))}
          />
          <View style={styles.reportModalCard}>
            <View style={styles.reportModalHeader}>
              <Ionicons name="receipt-outline" size={22} color={colors.text} />
              <Text style={styles.reportModalTitle}>Confirm Charge</Text>
            </View>
            <Text style={styles.reportModalReport}>{confirmReport?.name}</Text>
            <Text style={styles.reportModalPrice}>
              R{confirmReport?.cost_zar?.toFixed(0) ?? "0"}
            </Text>
            <Text style={styles.reportModalBody}>
              By continuing, you accept the charge of R{confirmReport?.cost_zar?.toFixed(0) ?? "0"}.
              This amount will be added to your next Fourbuy invoice alongside the R50 valuation fee.
            </Text>
            <Text style={styles.reportModalBodySmall}>
              The report will be run against VIN {sub?.vin || "—"}.
            </Text>

            <View style={styles.reportModalActions}>
              <TouchableOpacity
                testID="cancel-report-order"
                style={styles.reportModalCancel}
                onPress={() => setConfirmReport(null)}
                disabled={!!orderingReportType}
              >
                <Text style={styles.reportModalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="confirm-report-order"
                style={[
                  styles.reportModalConfirm,
                  !!orderingReportType && styles.docBtnDisabled,
                ]}
                onPress={submitReportOrder}
                disabled={!!orderingReportType}
              >
                {orderingReportType ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.reportModalConfirmText}>
                    Accept & Order
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Report result viewer modal */}
      <Modal
        visible={viewingReport !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setViewingReport(null)}
      >
        <View style={styles.reportModalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setViewingReport(null)} />
          <View style={styles.viewReportCard}>
            <View style={styles.viewReportHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.viewReportKicker}>
                  {viewingReport?.status?.toUpperCase() || "REPORT"}
                </Text>
                <Text style={styles.viewReportTitle}>{viewingReport?.name}</Text>
                <Text style={styles.viewReportMeta}>
                  VIN {viewingReport?.vin} · Delivered {(viewingReport?.delivered_at || viewingReport?.ordered_at || "").slice(0, 10)}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setViewingReport(null)} testID="close-report-viewer">
                <Ionicons name="close" size={26} color={colors.text} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: 480 }} contentContainerStyle={{ paddingBottom: spacing.md }}>
              {viewingReport?.result_data ? (
                <ReportResultBody data={viewingReport.result_data} />
              ) : (
                <Text style={styles.viewReportBody}>
                  This report was ordered but no result payload is attached yet.
                </Text>
              )}
              <View style={styles.mockBanner}>
                <Ionicons name="information-circle-outline" size={16} color={colors.textDisabled} />
                <Text style={styles.mockBannerText}>
                  MOCK DATA — real provider APIs will replace this content once integrated.
                </Text>
              </View>
            </ScrollView>

            {viewingReport?.status === "delivered" ? (
              <TouchableOpacity
                testID="open-report-pdf"
                style={styles.reportPdfBtn}
                onPress={() => viewingReport && handleOpenReportPdf(viewingReport.type)}
              >
                <Ionicons name="document-text-outline" size={18} color={colors.onPrimary} />
                <Text style={styles.reportPdfBtnText}>Open Full Report PDF</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function DetailRow({
  label,
  value,
  valueColor,
  last,
  mono,
}: {
  label: string;
  value: string;
  valueColor?: string;
  last?: boolean;
  mono?: boolean;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.detailRow, last && { borderBottomWidth: 0 }]}>
      <Text style={styles.detailRowLabel}>{label}:</Text>
      <Text
        style={[
          styles.detailRowValue,
          mono && { fontFamily: fonts.mono, letterSpacing: 0.5 },
          valueColor ? { color: valueColor } : null,
        ]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

function HeroPill({ label, value }: { label: string; value?: number }) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.heroPill}>
      <Text style={styles.heroPillLabel}>{label}</Text>
      <Text style={styles.heroPillValue}>{value ? `${value}/10` : "—"}</Text>
    </View>
  );
}

/**
 * Renders a structured report result payload. Handles arbitrary keys by
 * grouping known sections first and then dumping the remainder as key/value
 * rows. Arrays are rendered as bulleted lists, nested objects as sub-rows.
 */
function ReportResultBody({ data }: { data: Record<string, any> }) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const summary = data.summary as string | undefined;
  const sections = data.sections as
    | Record<string, Record<string, any> | any[]>
    | undefined;

  const renderValue = (v: any): string => {
    if (v == null) return "—";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (Array.isArray(v)) return v.map((x) => renderValue(x)).join(", ");
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };

  // BMW Factory Options result (from Bimmervin) has a different shape than
  // the Lightstone/CarVertical mock reports — no summary/sections, just
  // {status:"ok", vin, options:[{code, kind, description}], ...}. Render
  // it inline as a list of code + description pills instead of using the
  // generic sections renderer.
  const isBmwOptions =
    data && data.status === "ok" && Array.isArray(data.options) && !sections;
  if (isBmwOptions) {
    const options = (data.options || []) as { code: string; kind: string; description?: string | null }[];
    return (
      <View>
        <Text style={[styles.viewReportBody, { marginBottom: spacing.sm }]}>
          {options.length} factory-fitted option{options.length === 1 ? "" : "s"} against VIN {data.vin || "—"}.
        </Text>
        <View style={styles.bimmerOptionsList}>
          {options.map((o) => (
            <View
              key={`${o.kind}-${o.code}`}
              style={o.description ? styles.bimmerOptionRow : styles.bimmerOptionRowBare}
            >
              <View style={styles.bimmerOptionKindBadge}>
                <Text style={styles.bimmerOptionKindText}>{o.kind}</Text>
              </View>
              <Text style={styles.bimmerOptionCodeStrong}>{o.code}</Text>
              {o.description ? (
                <Text style={styles.bimmerOptionDesc} numberOfLines={2}>
                  {o.description}
                </Text>
              ) : (
                <Text style={styles.bimmerOptionDescMuted}>—</Text>
              )}
            </View>
          ))}
        </View>
      </View>
    );
  }

  // JLR OSH result — {status:"ok", vehicle, last_service, alerts[], services[]}.
  // Render the panels manually so admins see the structured data straight
  // away without having to fish it out of a generic sections block.
  const isJlrOsh =
    data && data.status === "ok" && (data.source || "").includes("landrover") && !sections;
  if (isJlrOsh) {
    const v = (data.vehicle || {}) as {
      vin?: string; model_name?: string; model_year?: string;
      engine?: string; colour?: string;
      warranty_start_date?: string; registration_country?: string;
    };
    const ls = data.last_service as
      | {
          type?: string; distance?: string; date?: string; job_number?: string;
          repairer_name?: string; repairer_location?: string; repairer_type?: string;
          service_items?: string[];
        }
      | null;
    const alerts = (data.alerts || []) as string[];
    const services = (data.services || []) as Array<{
      repairer?: string; job_number?: string; job_date?: string;
      odometer?: string; details?: string;
    }>;
    return (
      <View>
        <Text style={styles.reportSectionHeader}>Vehicle</Text>
        {[
          ["VIN", v.vin],
          ["Model", v.model_name],
          ["Model Year", v.model_year],
          ["Engine", v.engine],
          ["Colour", v.colour],
          ["Warranty Start Date", v.warranty_start_date],
          ["Registration Country", v.registration_country],
        ].map(([label, val]) =>
          val ? (
            <View key={String(label)} style={styles.reportRow}>
              <Text style={styles.reportRowLabel}>{label}</Text>
              <Text style={styles.reportRowValue}>{val}</Text>
            </View>
          ) : null,
        )}

        {services.length > 0 ? (
          <>
            <Text style={styles.reportSectionHeader}>
              Service History ({services.length})
            </Text>
            {services.map((s, i) => (
              <View key={`svc-${i}`} style={styles.serviceHistoryRow}>
                <View style={styles.serviceHistoryHeadRow}>
                  <Text style={styles.serviceHistoryDate}>
                    {s.job_date || "—"}
                  </Text>
                  <Text style={styles.serviceHistoryOdo}>
                    {s.odometer ? `${s.odometer} km` : ""}
                  </Text>
                </View>
                {s.repairer ? (
                  <Text style={styles.serviceHistoryRepairer}>{s.repairer}</Text>
                ) : null}
                <View style={styles.serviceHistoryMetaRow}>
                  {s.job_number ? (
                    <Text style={styles.serviceHistoryJob}>Job #{s.job_number}</Text>
                  ) : null}
                  {s.details ? (
                    <Text style={styles.serviceHistoryDetails} numberOfLines={3}>
                      {s.details}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </>
        ) : null}

        {ls ? (
          <>
            <Text style={styles.reportSectionHeader}>
              {services.length > 0 ? "Latest Service Detail" : "Last Service Recorded"}
            </Text>
            {[
              ["Type", ls.type],
              ["Distance", ls.distance],
              ["Date", ls.date],
              ["Job Number", ls.job_number],
              ["Repairer", ls.repairer_name],
              ["Location", ls.repairer_location],
            ].map(([label, val]) =>
              val ? (
                <View key={String(label)} style={styles.reportRow}>
                  <Text style={styles.reportRowLabel}>{label}</Text>
                  <Text style={styles.reportRowValue}>{val}</Text>
                </View>
              ) : null,
            )}
            {Array.isArray(ls.service_items) && ls.service_items.length > 0 ? (
              <>
                <Text style={[styles.reportRowLabel, { marginTop: spacing.sm }]}>Service Items</Text>
                {ls.service_items.map((item, i) => (
                  <Text key={`si-${i}`} style={styles.reportBullet}>•  {item}</Text>
                ))}
              </>
            ) : null}
          </>
        ) : services.length === 0 ? (
          <Text style={[styles.viewReportBody, { marginTop: spacing.sm }]}>
            No service records found for this VIN in JLR&apos;s South African database.
          </Text>
        ) : null}

        {alerts.length > 0 ? (
          <>
            <Text style={styles.reportSectionHeader}>
              Outstanding Alerts ({alerts.length})
            </Text>
            {alerts.map((a, i) => (
              <Text key={`al-${i}`} style={styles.reportBullet}>•  {a}</Text>
            ))}
          </>
        ) : null}
      </View>
    );
  }

  return (
    <View>
      {summary ? (
        <Text style={[styles.viewReportBody, { marginBottom: spacing.sm }]}>{summary}</Text>
      ) : null}

      {sections && typeof sections === "object"
        ? Object.entries(sections).map(([sectionName, sectionValue]) => (
            <View key={sectionName}>
              <Text style={styles.reportSectionHeader}>{sectionName}</Text>
              {Array.isArray(sectionValue)
                ? sectionValue.map((item, i) => (
                    <Text key={`${sectionName}-${i}`} style={styles.reportBullet}>
                      •  {renderValue(item)}
                    </Text>
                  ))
                : Object.entries(sectionValue || {}).map(([k, v]) => (
                    <View key={`${sectionName}-${k}`} style={styles.reportRow}>
                      <Text style={styles.reportRowLabel}>{k}</Text>
                      <Text style={styles.reportRowValue}>{renderValue(v)}</Text>
                    </View>
                  ))}
            </View>
          ))
        : null}
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  deleteBtn: { padding: 4 },
  backBtn: { padding: 4 },
  headerTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
    fontFamily: fonts.heading,
    flex: 1,
    textAlign: "center",
    letterSpacing: 0.3,
  },
  scroll: { padding: spacing.lg, paddingBottom: 120 },
  // ----- "Vehicle Unseen" warning banner (top of detail page) -----
  unseenBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.2,
    borderColor: "#B3261E",
    backgroundColor: "#FDECEA",
  },
  unseenBannerTitle: {
    color: "#B3261E",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  unseenBannerHint: {
    color: "#6B2018",
    fontSize: 11,
    marginTop: 2,
    lineHeight: 15,
  },

  // Reference badge — high-contrast, clean mono readout
  refBadge: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    marginBottom: spacing.md,
  },
  refBadgeLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.5,
  },
  refBadgeValue: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800",
    fontFamily: fonts.mono,
    letterSpacing: 1,
  },

  // "Submitted by" chip
  submittedByChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.paper,
    marginBottom: spacing.md,
  },
  submittedByText: { color: colors.textSecondary, fontSize: 12, flex: 1 },
  submittedByBold: { color: colors.text, fontWeight: "700" },

  // Hero average rating
  heroBox: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    alignItems: "center",
  },
  heroLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  heroTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    marginBottom: spacing.sm,
  },
  heroInfoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  heroInfoText: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
  heroRow: { flexDirection: "row", alignItems: "baseline" },
  heroValue: {
    color: colors.text,
    fontSize: 64,
    fontWeight: "900",
    fontFamily: fonts.mono,
    letterSpacing: -1,
    lineHeight: 68,
  },
  heroOutOf: {
    color: colors.textSecondary,
    fontSize: 20,
    fontWeight: "700",
    fontFamily: fonts.mono,
    marginLeft: 4,
  },
  heroBar: {
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 3,
    marginTop: spacing.md,
    width: "100%",
    overflow: "hidden",
  },
  heroBarFill: { height: "100%", backgroundColor: "#fff" },
  heroBreakdown: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
    width: "100%",
    justifyContent: "space-between",
  },
  heroPill: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.paper,
  },
  heroPillLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  heroPillValue: { color: colors.text, fontSize: 13, fontWeight: "800", fontFamily: fonts.mono, marginTop: 2 },

  priceBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderLight,
    marginBottom: spacing.lg,
  },
  priceLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  priceValue: { color: colors.text, fontSize: 30, fontWeight: "800", fontFamily: fonts.number, fontVariant: ["tabular-nums"], letterSpacing: -0.3, marginTop: 4 },
  priceNotes: { color: colors.textSecondary, fontSize: 13, marginTop: 4 },
  pendingBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.lg,
  },
  pendingText: { color: colors.textSecondary, fontWeight: "700", letterSpacing: 0.5, fontSize: 13 },

  // Price history log
  priceHistoryBox: {
    marginBottom: spacing.md,
  },
  priceHistoryRow: {
    flexDirection: "row",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  priceHistoryDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.text,
    marginTop: 6,
  },
  priceHistoryHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  priceHistoryAction: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.4,
  },
  priceHistoryDate: {
    color: colors.textDisabled,
    fontSize: 10,
    fontFamily: fonts.mono,
  },
  priceHistoryPriceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  priceHistoryOld: {
    color: colors.textSecondary,
    fontSize: 13,
    fontFamily: fonts.number,
    fontVariant: ["tabular-nums"],
    textDecorationLine: "line-through",
  },
  priceHistoryNew: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800",
    fontFamily: fonts.number,
    fontVariant: ["tabular-nums"],
  },
  priceHistoryDelta: {
    fontSize: 11,
    fontWeight: "700",
    fontFamily: fonts.number,
    fontVariant: ["tabular-nums"],
    marginLeft: 4,
  },
  priceHistoryComment: {
    color: colors.text,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  priceHistoryAdmin: {
    color: colors.textDisabled,
    fontSize: 10,
    marginTop: 4,
    fontStyle: "italic",
  },

  // Declined state (dealer view)
  declinedBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  declinedIconWrap: {
    paddingTop: 2,
  },
  declinedLabel: {
    color: colors.text,
    fontWeight: "800",
    letterSpacing: 1.3,
    fontSize: 12,
    marginBottom: 4,
    textTransform: "uppercase",
  },
  declinedBody: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  declinedMeta: {
    color: colors.textDisabled,
    fontSize: 11,
    marginTop: 6,
    fontFamily: fonts.mono,
  },

  // "Cannot Offer" admin footer button
  declineBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    borderRadius: radius.md,
    gap: 6,
    minWidth: 130,
  },
  declineBtnText: {
    color: colors.text,
    fontWeight: "800",
    letterSpacing: 0.8,
    fontSize: 13,
    textTransform: "uppercase",
  },

  // Decline modal — dealer-facing quote block
  declineQuote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.text,
    paddingLeft: spacing.sm,
    paddingVertical: 8,
    marginVertical: spacing.sm,
  },
  declineQuoteText: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
    fontStyle: "italic",
  },

  // Reports & Documents section
  reportsSection: {
    marginBottom: spacing.lg,
  },
  reportsSubhead: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginTop: spacing.md,
    marginBottom: 4,
  },
  reportsHelp: {
    color: colors.textDisabled,
    fontSize: 12,
    marginBottom: spacing.sm,
    lineHeight: 17,
  },
  docBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  docBtnLeft: { flexDirection: "row", alignItems: "center", flex: 1, marginRight: spacing.sm },
  docBtnTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  docBtnSubtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 16 },
  docBtnDisabled: { opacity: 0.5 },
  reportCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  reportName: { color: colors.text, fontSize: 14, fontWeight: "700", lineHeight: 18 },
  reportCost: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 2,
    fontFamily: fonts.number,
    fontVariant: ["tabular-nums"],
  },
  reportStatusRow: { marginTop: 8 },
  statusPill: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    marginBottom: 4,
  },
  statusPillPending: { borderColor: colors.warning + "77", backgroundColor: colors.warning + "1A" },
  statusPillOk: { borderColor: colors.success + "77", backgroundColor: colors.success + "1A" },
  statusPillText: { fontSize: 10, fontWeight: "800", letterSpacing: 1.1 },
  reportPendingNote: { color: colors.textDisabled, fontSize: 11, lineHeight: 15 },
  reportOrderedBadge: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
  reportOrderedBadgeText: { color: colors.text, fontSize: 11, fontWeight: "700", marginLeft: 4, letterSpacing: 0.5 },
  orderBtn: {
    backgroundColor: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.sm,
    minWidth: 80,
    alignItems: "center",
  },
  orderBtnText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 1, fontSize: 12, textTransform: "uppercase" },

  // Report confirmation modal
  reportModalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  reportModalCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  reportModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  reportModalTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800",
    marginLeft: 8,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  reportModalReport: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
    marginTop: spacing.sm,
  },
  reportModalPrice: {
    color: colors.text,
    fontSize: 32,
    fontWeight: "800",
    fontFamily: fonts.number,
    fontVariant: ["tabular-nums"],
    marginTop: 4,
    marginBottom: spacing.sm,
  },
  reportModalBody: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: spacing.xs,
  },
  reportModalBodySmall: {
    color: colors.textDisabled,
    fontSize: 12,
    marginBottom: spacing.md,
  },
  reportModalActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  reportModalCancel: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  reportModalCancelText: { color: colors.text, fontWeight: "700", letterSpacing: 0.5 },
  reportModalConfirm: {
    flex: 1.4,
    paddingVertical: 14,
    borderRadius: radius.sm,
    backgroundColor: colors.text,
    alignItems: "center",
  },
  reportModalConfirmText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },

  titleBox: { marginBottom: spacing.md },
  brand: { color: colors.textSecondary, fontSize: 13, fontWeight: "600", letterSpacing: 0.5 },
  model: {
    color: colors.text,
    fontSize: 26,
    fontWeight: "800",
    fontFamily: fonts.heading,
    letterSpacing: 0.3,
    marginTop: 2,
  },
  derivative: { color: colors.textSecondary, fontSize: 15, marginTop: 4, letterSpacing: 0.1 },

  // Vertical detail list — used for Vehicle Details, Condition, etc.
  detailsList: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  detailRowLabel: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: "500",
    letterSpacing: 0.1,
  },
  detailRowValue: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.1,
    flex: 1,
    textAlign: "right",
  },

  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  gridItem: {
    width: "31%",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: 4,
  },
  gridLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  gridValue: { color: colors.text, fontSize: 13, fontWeight: "700" },

  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.4,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },

  infoCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 6,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  infoLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 1, minWidth: 110 },
  infoValue: { color: colors.text, fontSize: 13, fontWeight: "700", flex: 1, textAlign: "right" },
  infoValueMono: { color: colors.text, fontSize: 12, fontWeight: "700", flex: 1, textAlign: "right", fontFamily: fonts.mono },

  reconRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  reconCardRow: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  reconHeadRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
  },
  reconPhotoStripDetail: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  reconThumbWrap: { width: 56, height: 56, borderRadius: radius.sm, overflow: "hidden", borderWidth: 1, borderColor: colors.border },
  reconThumb: { width: "100%", height: "100%" },
  reconLabel: { color: colors.text, fontSize: 13, flex: 1 },
  reconAmount: { color: colors.text, fontSize: 14, fontWeight: "700", fontFamily: fonts.number, fontVariant: ["tabular-nums"] },
  reconTotalRow: { flexDirection: "row", justifyContent: "space-between", paddingTop: spacing.sm, marginTop: 4 },
  reconTotalLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  reconTotalValue: { color: "#fff", fontSize: 18, fontWeight: "800", fontFamily: fonts.number, fontVariant: ["tabular-nums"], letterSpacing: -0.2 },

  photoGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  photoSlot: {
    width: "48%",
    aspectRatio: 1,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  photoImg: { width: "100%", height: "100%" },
  photoOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  photoLabel: { color: "#fff", fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  photoLabelDim: { color: colors.textDisabled, fontSize: 11, fontWeight: "700", letterSpacing: 1, marginTop: 4 },

  diskBox: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md },
  diskText: { color: colors.text, fontFamily: fonts.mono, fontSize: 12 },
  diskDecodedBox: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 6,
  },
  diskDecodedRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  diskDecodedLabel: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "500",
    letterSpacing: 0.1,
    minWidth: 110,
  },
  diskDecodedValue: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
    flex: 1,
    textAlign: "right",
  },

  analysisHeader: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginTop: spacing.lg, marginBottom: spacing.sm },
  analysisTs: { color: colors.textDisabled, fontSize: 11, marginTop: 2 },
  analysisBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.card,
    minWidth: 90,
    justifyContent: "center",
  },
  analysisBtnText: { color: colors.text, fontWeight: "800", fontSize: 11, letterSpacing: 1 },
  analysisCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md },
  rangeBox: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    overflow: "hidden",
    marginBottom: spacing.md,
  },
  rangeCol: { flex: 1, padding: spacing.sm, alignItems: "center" },
  rangeColMid: { backgroundColor: colors.paper, borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.border },
  rangeLabel: { color: colors.textSecondary, fontSize: 10, letterSpacing: 1, fontWeight: "700", marginBottom: 4 },
  rangeValue: { color: colors.text, fontSize: 15, fontWeight: "800", fontFamily: fonts.number, fontVariant: ["tabular-nums"], letterSpacing: -0.1 },
  tradeRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  tradeCol: { flex: 1, padding: spacing.sm, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  tradeLabel: { color: colors.textSecondary, fontSize: 10, letterSpacing: 1, fontWeight: "700", marginBottom: 4 },
  tradeValue: { color: colors.text, fontSize: 17, fontWeight: "800", fontFamily: fonts.number, fontVariant: ["tabular-nums"], letterSpacing: -0.2 },
  summary: { color: colors.text, fontSize: 13, lineHeight: 19, marginBottom: spacing.sm },
  factorsBox: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, gap: 6 },
  factorsTitle: { color: colors.textSecondary, fontSize: 10, letterSpacing: 1, fontWeight: "700", marginBottom: 4 },
  factorRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  factorText: { color: colors.text, fontSize: 12, flex: 1, lineHeight: 17 },
  confidence: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", marginTop: spacing.sm, letterSpacing: 1 },
  disclaimer: { color: colors.textDisabled, fontSize: 11, fontStyle: "italic", marginTop: 4 },
  analysisEmpty: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  analysisEmptyText: { color: colors.textSecondary, fontSize: 12, flex: 1, lineHeight: 17 },

  // Tyre estimate section styles
  tyreHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  tyreSpecBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: "#000",
  },
  tyreSpecText: { color: "#fff", fontFamily: fonts.mono, fontSize: 13, fontWeight: "700", letterSpacing: 0.5 },
  tyreRimText: { color: colors.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 }, // legacy — retained for a11y snapshots
  tyreTotalBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.paper,
    marginBottom: spacing.md,
    alignItems: "center",
  },
  tyreTotalLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  tyreTotalValue: { color: "#fff", fontSize: 28, fontWeight: "800", fontFamily: fonts.number, fontVariant: ["tabular-nums"], letterSpacing: -0.3, marginTop: 4 },

  dealerBox: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md },
  dealerName: { color: colors.text, fontSize: 15, fontWeight: "700" },
  dealerCompany: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  dealerEmail: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  whatsappBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: spacing.md,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: "#25D366",
    backgroundColor: "#25D36618",
  },
  whatsappBtnText: { color: "#25D366", fontWeight: "700", fontSize: 14, letterSpacing: 0.5 },

  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.md,
    backgroundColor: colors.paper,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    flexDirection: "row",
    gap: spacing.sm,
  },
  priceBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
  },
  priceBtnText: { color: colors.onPrimary, fontWeight: "800", fontSize: 15, letterSpacing: 0.4 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: colors.paper,
    padding: spacing.lg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 0.3 },
  modalHint: { color: colors.textSecondary, fontSize: 13, marginBottom: spacing.sm },
  label: { color: colors.textSecondary, fontSize: 13, marginTop: spacing.sm },
  priceInput: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    fontFamily: fonts.mono,
  },
  confirmBtn: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: radius.sm,
    alignItems: "center",
  },
  confirmBtnText: { color: colors.onPrimary, fontWeight: "800", fontSize: 15, letterSpacing: 0.4 },

  // Admin "no reports yet" hint
  adminNoReports: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    marginTop: spacing.sm,
  },
  adminNoReportsText: {
    color: colors.textDisabled,
    fontSize: 12,
    marginLeft: 8,
    flex: 1,
    lineHeight: 16,
  },

  // Registered-after-discontinued banner on vehicle detail
  discontinuedBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: colors.paper,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warning,
    padding: spacing.sm + 2,
    marginBottom: spacing.sm,
  },
  discontinuedBannerText: {
    flex: 1,
    color: colors.warning,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "700",
  },

  // Inline admin pricing block at the bottom of the scroll content.
  adminActionBox: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },

  // Kredo Vehicle Values card — new list price, M&M code, trade + retail.
  marketValuesCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.lg,
  },
  marketRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  marketLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  marketValue: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  marketFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: spacing.sm + 2,
    gap: spacing.sm,
  },
  marketFooterText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 11,
    letterSpacing: 0.3,
  },
  marketRefreshBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
    minWidth: 84,
    justifyContent: "center",
  },
  marketRefreshText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  // Small "locked at valuation" pill — replaces the Refresh CTA once a
  // successful snapshot has been captured, since trade/retail values are
  // fixed at the time of valuation and must not drift.
  marketLockedPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  marketLockedText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  marketLoadingBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  marketLoadingText: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  // ---- Bimmervin (BMW factory spec) styles -------------------------------
  bimmerSubHeader: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: spacing.sm,
  },
  bimmerFetchRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  bimmerFetchTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 2,
  },
  bimmerFetchHint: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 14,
  },
  bimmerFetchBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.neon,
    minWidth: 96,
    justifyContent: "center",
  },
  bimmerFetchBtnText: {
    color: colors.onPrimary,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  bimmerOptionsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.sm,
  },
  bimmerOptionPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  bimmerOptionKind: {
    color: colors.textSecondary,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  bimmerOptionCode: {
    color: colors.text,
    fontSize: 11,
    fontFamily: fonts.mono,
    letterSpacing: 0.5,
    fontWeight: "700",
  },
  // Rich-row option list variant that shows a description next to each
  // code. Used when the local dictionary yields a human label; codes
  // without a description fall back to the bare (short) row layout.
  bimmerOptionsList: {
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.sm,
    gap: 6,
  },
  bimmerOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  bimmerOptionRowBare: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    backgroundColor: "transparent",
    opacity: 0.72,
  },
  bimmerOptionKindBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: colors.neon + "22",
    minWidth: 22,
    alignItems: "center",
  },
  bimmerOptionKindText: {
    color: colors.text,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  bimmerOptionCodeStrong: {
    color: colors.text,
    fontSize: 12,
    fontFamily: fonts.mono,
    fontWeight: "800",
    letterSpacing: 0.5,
    minWidth: 46,
  },
  bimmerOptionDesc: {
    color: colors.text,
    fontSize: 12,
    lineHeight: 15,
    flex: 1,
  },
  bimmerOptionDescMuted: {
    color: colors.textSecondary,
    fontSize: 12,
    flex: 1,
    fontStyle: "italic",
  },
  marketErrorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
  },
  marketErrorText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
  },
  marketErrorDetail: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
    lineHeight: 16,
  },
  marketHint: {
    color: colors.textSecondary,
    fontSize: 10,
    fontStyle: "italic",
    marginTop: 2,
    letterSpacing: 0.3,
  },
  adminCurrentPrice: {
    backgroundColor: colors.paper,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm + 2,
    marginBottom: spacing.xs,
  },
  adminCurrentPriceLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.5,
  },
  adminCurrentPriceValue: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "900",
    letterSpacing: 0.5,
    marginTop: 2,
    fontFamily: fonts.number,
  },

  // Status pill used inside a report card for CarTrust pending/completed
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusPillPending: { backgroundColor: colors.paper, borderColor: colors.warning },
  statusPillOk: { backgroundColor: colors.success, borderColor: colors.success },
  statusPillText: { fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  statusPillTextPending: { color: colors.warning },
  statusPillTextOk: { color: colors.onPrimary },
  reportStatusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  reportStatusMeta: { color: colors.textSecondary, fontSize: 11, flex: 1 },
  viewReportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.sm,
  },
  viewReportBtnText: { color: colors.onPrimary, fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  reportOrderedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
  reportOrderedBadgeText: { color: colors.text, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },

  // Kredo VIN accident history card
  kredoHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  kredoFetchBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderRadius: radius.md,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    minHeight: 44,
  },
  kredoFetchBtnDisabled: {
    opacity: 0.6,
  },
  kredoFetchBtnText: { color: colors.onPrimary, fontSize: 13, fontWeight: "800", letterSpacing: 0.5 },
  kredoEmpty: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  kredoEmptyText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  kredoClean: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  kredoCleanTitle: { color: colors.text, fontSize: 14, fontWeight: "800" },
  kredoCleanSub: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  kredoCountBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    marginBottom: spacing.sm,
  },
  kredoCountText: { flex: 1, color: colors.text, fontSize: 13, fontWeight: "800", letterSpacing: 0.5 },
  kredoSource: { color: colors.textSecondary, fontSize: 10, letterSpacing: 1, textTransform: "uppercase" },
  claimCard: {
    backgroundColor: colors.paper,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  claimHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  claimDate: { color: colors.text, fontSize: 14, fontWeight: "800" },
  claimCountry: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  claimVehicle: { color: colors.text, fontSize: 12, marginBottom: 2 },
  claimMeta: { color: colors.textSecondary, fontSize: 11, marginBottom: 6 },
  damageRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4, marginBottom: 4 },
  damageChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: colors.danger,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  damageChipGlass: { backgroundColor: colors.warning },
  damageChipText: { color: "#fff", fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  claimId: {
    color: colors.textDisabled,
    fontSize: 10,
    fontFamily: fonts.mono,
    marginTop: 4,
  },

  // CarTrust PDF report states
  cartrustPending: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  cartrustPendingTitle: { color: colors.text, fontSize: 13, fontWeight: "800" },
  cartrustPendingSub: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  cartrustReady: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.success,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cartrustReadyTitle: { color: colors.text, fontSize: 14, fontWeight: "800" },
  cartrustReadySub: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  cartrustViewBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 12,
  },
  cartrustViewBtnText: { color: colors.onPrimary, fontWeight: "800", fontSize: 13, letterSpacing: 0.5 },

  // View Report button (delivered)
  viewReportBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.sm,
    minWidth: 80,
    justifyContent: "center",
  },
  viewReportBtnText: {
    color: colors.onPrimary,
    fontWeight: "800",
    letterSpacing: 1,
    fontSize: 12,
    marginLeft: 4,
    textTransform: "uppercase",
  },

  // Report viewer modal
  viewReportCard: {
    width: "100%",
    maxWidth: 520,
    maxHeight: "88%",
    backgroundColor: colors.paper,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  viewReportHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  viewReportKicker: {
    color: colors.success,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.5,
  },
  viewReportTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800",
    marginTop: 4,
    lineHeight: 20,
  },
  viewReportMeta: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 4,
    fontFamily: fonts.mono,
  },
  viewReportBody: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  reportSectionHeader: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginTop: spacing.md,
    marginBottom: 6,
  },
  reportRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  reportRowLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    flex: 1,
  },
  reportRowValue: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
    flexShrink: 1,
    textAlign: "right",
    maxWidth: "60%",
  },
  reportBullet: {
    color: colors.text,
    fontSize: 12,
    paddingVertical: 3,
    lineHeight: 17,
  },
  serviceHistoryRow: {
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    paddingVertical: spacing.sm,
    gap: 2,
  },
  serviceHistoryHeadRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  serviceHistoryDate: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
  },
  serviceHistoryOdo: {
    color: colors.textSecondary,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  serviceHistoryRepairer: {
    color: colors.text,
    fontSize: 12,
    marginTop: 2,
  },
  serviceHistoryMetaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: spacing.sm,
    marginTop: 2,
  },
  serviceHistoryJob: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  serviceHistoryDetails: {
    color: colors.textSecondary,
    fontSize: 11,
    flex: 1,
    textAlign: "right",
    lineHeight: 15,
  },
  mockBanner: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.md,
    padding: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    backgroundColor: colors.card,
  },
  mockBannerText: {
    color: colors.textDisabled,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginLeft: 6,
    flex: 1,
  },
  reportPdfBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.text,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderRadius: radius.sm,
  },
  reportPdfBtnText: {
    color: colors.onPrimary,
    fontWeight: "800",
    letterSpacing: 1,
    marginLeft: 6,
    textTransform: "uppercase",
    fontSize: 13,
  },
});
