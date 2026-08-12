import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Image, TextInput, Modal, KeyboardAvoidingView, Platform, Alert, LayoutAnimation, UIManager, Keyboard } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { spacing, radius, fonts } from "@/src/theme";

// LayoutAnimation is opt-in on Android — enable it once at module load
// so the collapsible section animations feel smooth on all platforms.
if (Platform.OS === "android" && UIManager?.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ---------------------------------------------------------------------------
// The types + subcomponents that used to live inline in this file were
// extracted into dedicated modules during the P1 modularization pass
// (Aug 2026). Behaviour is unchanged — pull them back in from their
// canonical homes:
//   • Types:        `/src/types/vehicle.ts`
//   • Stylesheet:   `/src/styles/vehicleDetailStyles.ts`
//   • Subcomponents: `/src/components/vehicle/{CollapsibleSection,DetailRow,HeroPill,ReportResultBody}.tsx`
// ---------------------------------------------------------------------------
import type {
  ReconItem,
  Submission,
  DealInfo,
  DealProfit,
  PriceHistoryEntry,
  ReportOrder,
  TyreEstimate,
  TyreEstimatePayload,
  MarketAnalysis,
  MarketAnalysisPayload,
} from "@/src/types/vehicle";
import { PHOTO_ORDER } from "@/src/types/vehicle";
import { makeStyles } from "@/src/styles/vehicleDetailStyles";
import CollapsibleSection from "@/src/components/vehicle/CollapsibleSection";
import DetailRow from "@/src/components/vehicle/DetailRow";
import HeroPill from "@/src/components/vehicle/HeroPill";
import ReportResultBody from "@/src/components/vehicle/ReportResultBody";
import { ConfirmReportModal, ViewReportModal } from "@/src/components/vehicle/modals/ReportModals";
import { PriceModal, DeclineModal } from "@/src/components/vehicle/modals/PriceDeclineModals";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { TOKEN_KEY } from "@/src/api";
import { useAuth } from "@/src/context/AuthContext";
import { buildWhatsappUrl, buildDealerMessage } from "@/src/utils/whatsapp";
import { decodeLicenseDisk } from "@/src/utils/licenseDisk";
// Keep in sync with SCAN_* keys in /app/frontend/app/(app)/scan.tsx.
const SCAN_BUFFER_KEY = "app.scan.buffer";
const SCAN_PARSED_KEY = "app.scan.parsed";
const SCAN_PHOTO_KEY = "app.scan.photo";
import PhotoCarousel, { CarouselPhoto } from "@/src/components/PhotoCarousel";
import ConditionRatingInfoModal from "@/src/components/ConditionRatingInfoModal";
import BrandLogo from "@/src/components/BrandLogo";
import ComparableListingsCard from "@/src/components/ComparableListingsCard";
import WeBuyCarsListingsCard from "@/src/components/WeBuyCarsListingsCard";
import { formatZAR, computeServiceGap, formatMonthsAgo, formatKm } from "@/src/utils/format";
import {
  resolvePhoto,
  formatMV,
  formatFetched,
  confirmAsync,
} from "@/src/utils/vehicle-detail";

export default function VehicleDetail() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { id, cover, attach } = useLocalSearchParams<{ id: string; cover?: string; attach?: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // Cover-mode: pricing agent inspecting a submission to place a
  // binding cover. Renders the SAME vehicle detail page but hides the
  // Fourbuy offer / offer history / admin controls, and swaps the
  // bottom action bar for a cover-placement input. Backend also
  // sanitises the response so admin_pricing / offer numbers never leak.
  const isCoverMode = cover === "1" || cover === "true";

  // Which of the collapsible content blocks are currently expanded. All
  // sections start closed by default so the valuation screen looks tidy
  // on first load — dealers/admin tap to reveal the details they want.
  // Persisted only in-memory; a hard refresh resets to the defaults.
  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set<string>(["reports", "market-values"]),
  );
  const toggleSection = useCallback((key: string) => {
    // Small LayoutAnimation for smooth reveal on both native and web.
    if (Platform.OS !== "web" && LayoutAnimation) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    }
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const isOpen = useCallback(
    (key: string) => openSections.has(key),
    [openSections],
  );

  const [sub, setSub] = useState<Submission | null>(null);
  // True when the currently signed-in user belongs to the same
  // dealership that submitted the vehicle. Any colleague on the same
  // dealership can SEE deal-tracking / dealer-offer data — only the
  // managerial (`is_pricing_agent`) users on that dealership can EDIT
  // it. Computed as a plain expression so it stays in sync with `sub`
  // on every render — hooks aren't needed here.
  const isOwningDealer = !!(
    user?.role === "dealer" &&
    sub &&
    (
      (((sub as any).dealership_id) && ((user as any).dealership_id) &&
        ((sub as any).dealership_id === (user as any).dealership_id)) ||
      ((sub as any).dealer_id && (sub as any).dealer_id === user?.id)
    )
  );
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

  // Cover Offers received on this submission (from Pricing Agents).
  // Visible only to the owning dealer + admins — the backend enforces
  // this and simply returns [] for non-authorised users.
  type CoverOffer = {
    id: string;
    price_zar: number;
    note?: string | null;
    status?: string;
    created_at: string;
    agent_name?: string | null;
    agent_phone?: string | null;
    agent_dealership_name?: string | null;
    agent_profile_pic?: string | null;
    binding_caveat?: string | null;
  };
  const [coverOffers, setCoverOffers] = useState<CoverOffer[]>([]);
  // Both the Cover Offers Received panel and the Fourbuy Offer History
  // are collapsed by default so the top of the page stays tight — the
  // dealer opens them on demand.
  const [coverOffersOpen, setCoverOffersOpen] = useState(false);
  const [priceHistoryOpen, setPriceHistoryOpen] = useState(false);

  // Cover-mode meta: the pricing agent's own placed cover (if any) and
  // the R10 cost we bill per cover placement. Only populated when
  // `isCoverMode`. Kept out of `coverOffers` because that array is for
  // the OWNER's Cover Offers Received panel.
  const [coverMeta, setCoverMeta] = useState<
    { my_cover: { price_zar: number; created_at: string; note?: string | null } | null; cover_cost_zar: number } | null
  >(null);
  const [placingCover, setPlacingCover] = useState(false);
  const [decliningCover, setDecliningCover] = useState(false);
  const [coverPriceInput, setCoverPriceInput] = useState("");

  // ---- Deal Tracking state ----------------------------------------------
  // Local input state for the four editable numeric fields — kept as
  // strings so the user can freely type (backend coerces on save). The
  // canonical persisted deal lives inside `sub.deal`.
  const [dealSaving, setDealSaving] = useState(false);
  // Tri-state outcome CHOICES held locally until the user hits Save.
  // "pending" is the default; "yes"/"no" are set when the user taps a
  // pill. Persisted state (`sub.deal.done`) only changes on save.
  type OutcomeChoice = "pending" | "yes" | "no";
  const [dealDoneChoice, setDealDoneChoice] = useState<OutcomeChoice>("pending");
  const [dealSoldChoice, setDealSoldChoice] = useState<OutcomeChoice>("pending");
  const [dealPurchaseInput, setDealPurchaseInput] = useState("");
  const [dealReconInput, setDealReconInput] = useState("");
  const [dealSaleInput, setDealSaleInput] = useState("");
  // Dealer's OWN pre-purchase offer to the seller. Gates the rest of
  // the Deal Tracking flow — until this is set, Stage 1 / Stage 2 are
  // hidden. Only pricing agents ("managerial access") on the owning
  // dealership can set it.
  const [dealOfferInput, setDealOfferInput] = useState("");
  // Whether the collapsible past-offer history under the Dealer Offer
  // card is expanded. Closed by default — the current amount is what
  // matters day-to-day; history is a "look under the hood" gesture.
  const [dealerOfferHistoryOpen, setDealerOfferHistoryOpen] = useState(false);
  const [dealPdfDownloading, setDealPdfDownloading] = useState(false);
  // Whenever the server-side `sub.deal` changes, mirror BOTH the tri-
  // state choices and the numeric fields into the local form state so
  // the UI reflects persisted values on load.
  useEffect(() => {
    const d = (sub as any)?.deal as DealInfo | null | undefined;
    setDealDoneChoice(
      d?.done === true ? "yes" : d?.done === false ? "no" : "pending",
    );
    // Stage 2 default when the deal is done but no sale answer yet is
    // "no" (Not yet) — no "pending" option per user spec. When the
    // deal isn't done, Stage 2 is hidden anyway so the value is moot.
    setDealSoldChoice(
      d?.sold === true
        ? "yes"
        : d?.sold === false
          ? "no"
          : d?.done === true
            ? "no"
            : "pending",
    );
    setDealPurchaseInput(
      d?.purchase_price_zar != null
        ? formatMoneyString(String(d.purchase_price_zar))
        : ""
    );
    setDealReconInput(
      d?.recon_cost_zar != null
        ? formatMoneyString(String(d.recon_cost_zar))
        : ""
    );
    setDealSaleInput(
      d?.sale_price_zar != null
        ? formatMoneyString(String(d.sale_price_zar))
        : ""
    );
    setDealOfferInput(
      d?.dealer_offer_zar != null
        ? formatMoneyString(String(d.dealer_offer_zar))
        : ""
    );
  }, [
    (sub as any)?.deal?.done,
    (sub as any)?.deal?.sold,
    (sub as any)?.deal?.purchase_price_zar,
    (sub as any)?.deal?.recon_cost_zar,
    (sub as any)?.deal?.sale_price_zar,
    (sub as any)?.deal?.dealer_offer_zar,
  ]);

  const parseMoneyInput = (raw: string): number | null => {
    // Accept "R 450 000", "450,000", "450000.50" — strips spaces, commas
    // and any leading "R". Returns null when the field is empty.
    const s = (raw || "").trim().replace(/[Rr]/g, "").replace(/[,\s]/g, "");
    if (!s) return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  };
  // Live comma-thousands formatter for numeric money inputs. Given any
  // user-typed string, strip out everything except digits + optional
  // decimal, then re-insert commas every three digits from the right so
  // the value on screen reads "1,234,500" as they type. Empty input
  // returns "" so the placeholder can show through.
  const formatMoneyString = (raw: string): string => {
    const cleaned = (raw || "").replace(/[^0-9.]/g, "");
    if (!cleaned) return "";
    // Preserve a trailing "." while the user is mid-typing decimals.
    const [intPart, ...rest] = cleaned.split(".");
    const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return rest.length ? `${withCommas}.${rest.join("")}` : withCommas;
  };
  const fmtZar = (v: number | null | undefined) => {
    if (v == null || !isFinite(Number(v))) return "—";
    return `R ${Math.round(Number(v)).toLocaleString("en-ZA")}`;
  };

  const patchDeal = useCallback(
    async (
      patch: Partial<{
        done: boolean | null;
        purchase_price_zar: number | null;
        sold: boolean | null;
        recon_cost_zar: number | null;
        sale_price_zar: number | null;
        dealer_offer_zar: number | null;
      }>,
    ) => {
      if (!sub) return;
      setDealSaving(true);
      try {
        const data = await apiFetch(`/api/submissions/${sub.id}/deal`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        setSub((prev) =>
          prev ? { ...prev, deal: data.deal, deal_profit: data.profit } : prev,
        );
      } catch (e: any) {
        if (Platform.OS === "web") {
          (globalThis as any).alert?.(e?.message || "Failed to update deal.");
        } else {
          Alert.alert("Update failed", e?.message || "Please try again.");
        }
      } finally {
        setDealSaving(false);
      }
    },
    [sub],
  );

  // ---- Explicit "Update Profit Analysis" save ----------------------------
  // We used to save numeric fields on blur, but if the user tapped the
  // back arrow before the field lost focus their last edit was silently
  // dropped. Now we hold pending edits in state and commit them ALL
  // together via a single PATCH when the user hits "Update Profit
  // Analysis". `dealFinancialsDirty` compares the current inputs to the
  // persisted values so we can enable/disable the button accordingly.
  // When the dealer flips Stage 1 to Yes, Stage 2 must have a definite
  // answer — either "yes" (sold) or "no" (not yet). If it's still on
  // the initial "pending" default from before Stage 1 was answered,
  // drop it to "no" so the buttons visibly reflect the correct state.
  useEffect(() => {
    if (dealDoneChoice === "yes" && dealSoldChoice === "pending") {
      setDealSoldChoice("no");
    }
  }, [dealDoneChoice, dealSoldChoice]);

  const choiceToApi = (c: OutcomeChoice): boolean | null =>
    c === "yes" ? true : c === "no" ? false : null;

  const dealFinancialsDirty = useMemo(() => {
    const d = (sub as any)?.deal as DealInfo | null | undefined;
    const persistedDone = d?.done === true ? "yes" : d?.done === false ? "no" : "pending";
    const persistedSold = d?.sold === true ? "yes" : d?.sold === false ? "no" : "pending";
    const cur = {
      done: dealDoneChoice,
      sold: dealSoldChoice,
      purchase_price_zar: parseMoneyInput(dealPurchaseInput),
      recon_cost_zar: parseMoneyInput(dealReconInput),
      sale_price_zar: parseMoneyInput(dealSaleInput),
    };
    return (
      cur.done !== persistedDone ||
      cur.sold !== persistedSold ||
      cur.purchase_price_zar !== (d?.purchase_price_zar ?? null) ||
      cur.recon_cost_zar !== (d?.recon_cost_zar ?? null) ||
      cur.sale_price_zar !== (d?.sale_price_zar ?? null)
    );
  }, [
    sub,
    dealDoneChoice,
    dealSoldChoice,
    dealPurchaseInput,
    dealReconInput,
    dealSaleInput,
  ]);

  const saveDealFinancials = useCallback(async () => {
    if (!dealFinancialsDirty) return;
    // Client-side guard mirroring the backend: sold=yes needs
    // done=yes first (recording a sale before a purchase makes no
    // sense).
    if (dealSoldChoice === "yes" && dealDoneChoice !== "yes") {
      if (Platform.OS === "web") {
        (globalThis as any).alert?.(
          "Mark the purchase as done before recording a sale.",
        );
      } else {
        Alert.alert(
          "Purchase not confirmed",
          "Mark the purchase as done before recording a sale.",
        );
      }
      return;
    }
    // Build the patch. Only include the sale block when the purchase
    // is confirmed — otherwise the backend cascades sold to null
    // anyway.
    await patchDeal({
      done: choiceToApi(dealDoneChoice),
      purchase_price_zar:
        dealDoneChoice === "yes" ? parseMoneyInput(dealPurchaseInput) : null,
      sold: dealDoneChoice === "yes" ? choiceToApi(dealSoldChoice) : null,
      recon_cost_zar:
        dealDoneChoice === "yes" && dealSoldChoice === "yes"
          ? parseMoneyInput(dealReconInput)
          : null,
      sale_price_zar:
        dealDoneChoice === "yes" && dealSoldChoice === "yes"
          ? parseMoneyInput(dealSaleInput)
          : null,
    });
  }, [
    dealFinancialsDirty,
    patchDeal,
    dealDoneChoice,
    dealSoldChoice,
    dealPurchaseInput,
    dealReconInput,
    dealSaleInput,
  ]);

  const handleDownloadProfitPdf = useCallback(async () => {
    if (!sub) return;
    setDealPdfDownloading(true);
    try {
      const url = `/api/submissions/${sub.id}/profit-analysis.pdf`;
      if (Platform.OS === "web") {
        // Fetch as blob + trigger a download link so the browser respects
        // our Content-Disposition filename instead of opening in-tab.
        // Auth token lives in SecureStore (persisted via `secureSet`),
        // so we MUST read it back with `secureGet` — the earlier
        // `storage.getItem` variant looked in AsyncStorage and always
        // resolved to null, which made the fetch fire without an
        // Authorization header → backend 401 → user saw "Download
        // failed (401)".
        const token = await storage.secureGet<string>(TOKEN_KEY, "");
        const base =
          (process.env as any).EXPO_PUBLIC_BACKEND_URL ||
          (globalThis as any).location?.origin ||
          "";
        const res = await fetch(`${base}${url}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`Download failed (${res.status})`);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = (globalThis as any).document?.createElement("a");
        if (a) {
          a.href = objectUrl;
          a.download = `profit_analysis_${sub.reference || sub.id}.pdf`;
          a.click();
        }
        setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
      } else {
        // Native (iOS / Android) — open the PDF inline in the in-app
        // WebBrowser, exactly like the reconditioning sheet does.
        // Previously the profit sheet went straight to a Share sheet
        // via FileSystem.downloadAsync + Sharing.shareAsync, which felt
        // heavier than needed — user just wants to preview.
        const token = await storage.secureGet<string>(TOKEN_KEY, "");
        const base = (process.env as any).EXPO_PUBLIC_BACKEND_URL || "";
        try {
          const previewUrl = `${base}${url}?access_token=${encodeURIComponent(token || "")}`;
          const opened = await WebBrowser.openBrowserAsync(previewUrl, {
            dismissButtonStyle: "close",
            controlsColor: colors.text,
            toolbarColor: colors.paper,
            enableBarCollapsing: true,
          });
          if (opened.type === "cancel" || opened.type === "dismiss") return;
        } catch (previewErr) {
          // Only fall back to Sharing if the in-app browser fails —
          // download to cache then hand off to the OS share sheet so
          // the user isn't dead-ended.
          // eslint-disable-next-line no-console
          console.error("[profit-pdf] preview failed:", previewErr);
          const dest = `${FileSystem.cacheDirectory}profit_${sub.id}.pdf`;
          const dl = await FileSystem.downloadAsync(`${base}${url}`, dest, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (dl.status >= 200 && dl.status < 300) {
            const canShare = await Sharing.isAvailableAsync();
            if (canShare) {
              await Sharing.shareAsync(dl.uri, {
                mimeType: "application/pdf",
                dialogTitle: "Profit Analysis",
                UTI: "com.adobe.pdf",
              });
              return;
            }
          }
          throw new Error(`Download failed (${dl.status})`);
        }
      }
    } catch (e: any) {
      if (Platform.OS === "web") {
        (globalThis as any).alert?.(e?.message || "Failed to download PDF.");
      } else {
        Alert.alert("Download failed", e?.message || "Please try again.");
      }
    } finally {
      setDealPdfDownloading(false);
    }
  }, [sub]);


  // Force the scroll view back to the top whenever we land on this
  // page in cover-mode (or when the submission id changes). Without
  // this, tapping a covered card from the /cover list occasionally
  // opened the vehicle detail scrolled down to the price bar, which
  // felt like it "jumped into the price input" instead of the top of
  // the valuation.
  const scrollRef = useRef<ScrollView | null>(null);
  useEffect(() => {
    if (!id) return;
    // Defer until after the initial layout so RN's ScrollView has a
    // frame to work against.
    const t = setTimeout(() => {
      try {
        scrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
      } catch {
        // no-op
      }
    }, 0);
    return () => clearTimeout(t);
  }, [id, isCoverMode]);

  // Track keyboard height so the cover-placement bar lifts above the
  // on-screen keyboard on native. On web the browser reflows the layout
  // automatically so we skip the listeners.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const s = Keyboard.addListener(showEvt, (e) => setKbHeight(e?.endCoordinates?.height || 0));
    const h = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { s.remove(); h.remove(); };
  }, []);

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

  const fetchKredoHistory = async (refresh = false, opts?: { skipConfirm?: boolean }) => {
    if (!sub?.id || !sub.vin) return;
    // Dealers must explicitly accept the R100 charge — only when this
    // will actually hit Kredo (i.e., no cache yet OR they tapped Refresh).
    // When invoked from the unified "Order a VIN-Linked Report" flow the
    // dealer has already confirmed the charge in the modal, so skip the
    // second confirmation to avoid double-prompting.
    const willBill = !isAdmin && (refresh || !kredoHistory);
    if (willBill && !opts?.skipConfirm) {
      // React Native Web's Alert.alert() polyfill silently discards
      // multi-button `onPress` callbacks, so the confirmation Promise
      // never resolves on web (the button click just did nothing).
      // Branch on Platform to use the native `window.confirm()` there,
      // and keep the rich Alert on iOS/Android.
      const confirmMessage =
        `A live Kredo VIN accident-and-claim check for ${sub.vin} will be added to your next invoice at R${KREDO_VIN_HISTORY_DEALER_COST_ZAR}. Continue?`;
      let proceed = false;
      if (Platform.OS === "web") {
        const w = (globalThis as unknown as { window?: Window & { confirm?: (m: string) => boolean } }).window;
        proceed = typeof w?.confirm === "function" ? !!w.confirm(confirmMessage) : true;
      } else {
        proceed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            "Accident / Claim History",
            confirmMessage,
            [
              { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
              { text: `Charge R${KREDO_VIN_HISTORY_DEALER_COST_ZAR}`, style: "default", onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          );
        });
      }
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

  const [loadError, setLoadError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const loadSub = useCallback(async () => {
    setLoadError(null);
    setExpired(false);
    try {
      const data = await apiFetch(`/api/submissions/${id}`);
      setSub(data.submission);
    } catch (e: any) {
      // 404 = the submission has been purged (retention window elapsed
      // or an admin deleted it). Treat this as a soft "expired" state:
      // clear the stale sub so we can't accidentally show data from a
      // previously-viewed vehicle, mark the flag so the UI can render
      // the "file expired" notice + Alert popup.
      const msg: string = (e?.message || "").toLowerCase();
      const is404 =
        msg.includes("not found") ||
        msg.includes("404") ||
        msg.includes("submission not found");
      if (is404) {
        setSub(null);
        setExpired(true);
        Alert.alert(
          "Submission expired",
          "This submission is no longer available — its retention window has elapsed or it was archived. Please re-submit the vehicle to generate a fresh valuation.",
          [{ text: "OK" }],
        );
      } else {
        setLoadError(e?.message || "Could not load this vehicle.");
      }
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    if (!id) return;
    // Reset all sub-scoped state when the route id changes so the
    // previously-viewed vehicle can never bleed into the current
    // render (this used to briefly show FB-000140 when the user
    // navigated to an expired FB-000105, until the fetch completed
    // and the 404 was swallowed).
    setSub(null);
    setCoverOffers([]);
    setCoverOffersOpen(false);
    setPriceHistoryOpen(false);
    setLoadError(null);
    setExpired(false);
    setLoading(true);
    loadSub();
  }, [id, loadSub]);

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

  // Load Cover Offers received on this submission — backend gates the
  // response so pricing agents / other dealers get [] here.
  const loadCoverOffers = useCallback(async () => {
    if (!sub?.id) return;
    try {
      const r = await apiFetch(`/api/submissions/${sub.id}/covers`);
      setCoverOffers((r?.covers as CoverOffer[]) || []);
    } catch {
      // 403s expected for non-owners; ignore.
    }
  }, [sub?.id]);
  useEffect(() => {
    loadCoverOffers();
  }, [loadCoverOffers]);

  // Cover-mode: pull my own cover + billing cost from the cover endpoint.
  const loadCoverMeta = useCallback(async () => {
    if (!sub?.id || !isCoverMode) return;
    try {
      const r = await apiFetch(`/api/cover/submissions/${sub.id}`);
      setCoverMeta({
        my_cover: r?.my_cover || null,
        cover_cost_zar: r?.cover_cost_zar ?? 10,
      });
    } catch {
      // Non-agents will get 403 — leave meta null so the bottom bar
      // stays hidden.
    }
  }, [sub?.id, isCoverMode]);
  useEffect(() => {
    loadCoverMeta();
  }, [loadCoverMeta]);

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
        } catch (e: any) {
          // If the sub was purged while the user had this screen open
          // (rare, but possible during a focus-refresh), surface the
          // same "expired" branch as the initial load handler.
          const msg: string = (e?.message || "").toLowerCase();
          if (msg.includes("not found") || msg.includes("404")) {
            if (!cancelled) {
              setSub(null);
              setExpired(true);
            }
          }
          /* other errors are ignored — initial load already surfaced them */
        }

        // "attach license disk" side-effect: the user just came back from
        // /scan?returnPath=attachDisk. Consume the stashed scan payload,
        // PATCH the sub non-billably, then refresh and show a toast.
        if (attach === "1" && !cancelled) {
          try {
            const raw = await storage.getItem(SCAN_BUFFER_KEY);
            const photo = await storage.getItem(SCAN_PHOTO_KEY);
            // Wipe the storage IMMEDIATELY so a re-focus can't
            // re-trigger the PATCH (route param can linger).
            await storage.removeItem(SCAN_BUFFER_KEY);
            await storage.removeItem(SCAN_PARSED_KEY);
            await storage.removeItem(SCAN_PHOTO_KEY);
            if (!raw || !raw.trim()) {
              Alert.alert(
                "No scan detected",
                "The scanner didn't return any data. Please try scanning the licence disc again.",
              );
            } else {
              try {
                const patched = await apiFetch(
                  `/api/submissions/${id}/license-disk`,
                  {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      license_disk_data: raw,
                      license_disk_photo: photo || undefined,
                    }),
                  },
                );
                if (!cancelled) {
                  setSub(patched.submission);
                  Alert.alert(
                    "Licence disc attached",
                    `VIN ${patched.vin} is now on this submission — VIN-linked reports are unlocked. Your invoice was not affected.`,
                  );
                }
              } catch (patchErr: any) {
                Alert.alert(
                  "Could not attach licence disc",
                  patchErr?.message ||
                    "Something went wrong updating this submission. Please try again.",
                );
              }
            }
          } catch (e) {
            console.log("attach license disk flow failed", e);
          }
          // Clear the `attach` param from the URL so refreshes don't
          // re-trigger the flow.
          try {
            router.setParams({ attach: undefined } as any);
          } catch (_e) {
            /* setParams is optional-safe */
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [id, attach])
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
    // Price UPDATES require a rationale comment (backend enforces this
    // too, but stopping the request client-side gives a nicer error
    // than a 400).
    if (sub?.status === "priced" && changeCommentInput.trim().length < 3) {
      Alert.alert(
        "Reason required",
        "Please tell the dealer why the offer has changed. This will be logged in the price history.",
      );
      return;
    }
    // Two-step confirmation: the "Confirm Price" button in the modal is
    // the FIRST step; this final confirmation is the explicit second step
    // so admins can't accidentally submit a wrong number.
    const vehicleLabel = `${sub?.year ?? ""} ${sub?.make_name ?? ""} ${sub?.derivative_name || sub?.model_name || ""}`.trim();
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
    // Kredo VIN accident / claim history — R100 live lookup, one charge
    // per submission, billed to the dealer's next invoice.
    kredo_vin_history: { name: "Accident / Claim History (Kredo VIN)", cost_zar: KREDO_VIN_HISTORY_DEALER_COST_ZAR },
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
    // Kredo VIN accident / claim history — uses a dedicated live-lookup
    // endpoint (POST /kredo/vin-history) instead of the standard reports
    // POST. `fetchKredoHistory(true)` runs a fresh Kredo call, writes the
    // R100 billing row into `report_orders`, and updates the cache. We
    // then refetch the submission so `sub.report_orders` includes the
    // new row and the card flips from "Order" to "View" instantly.
    if ((confirmReport.type as string) === "kredo_vin_history") {
      setConfirmReport(null);
      setOrderingReportType("kredo_vin_history");
      try {
        await fetchKredoHistory(true, { skipConfirm: true });
        // Refetch submission so the unified report list reflects the new
        // billing row.
        try {
          const fresh = await apiFetch(`/api/submissions/${id}`);
          setSub(fresh);
        } catch { /* non-fatal */ }
      } finally {
        setOrderingReportType(null);
      }
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

  const [downloadingRecon, setDownloadingRecon] = useState(false);
  const handleDownloadReconditioningPdf = async () => {
    if (!sub) return;
    setDownloadingRecon(true);
    try {
      const backend = process.env.EXPO_PUBLIC_BACKEND_URL;
      if (!backend) throw new Error("Missing EXPO_PUBLIC_BACKEND_URL");
      const path = `/api/submissions/${sub.id}/reconditioning.pdf`;
      const token = await storage.secureGet<string>(TOKEN_KEY, "");
      const filename = `reconditioning_${sub.reference || sub.id}.pdf`;

      if (Platform.OS === "web") {
        const res = await fetch(`${backend}${path}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`Server returned HTTP ${res.status} ${errText.slice(0, 120)}`);
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        window.open(objectUrl, "_blank");
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      } else {
        const url = `${backend}${path}?access_token=${encodeURIComponent(token || "")}`;
        const opened = await WebBrowser.openBrowserAsync(url, {
          dismissButtonStyle: "close",
          controlsColor: colors.text,
          toolbarColor: colors.paper,
          enableBarCollapsing: true,
        });
        if (opened.type === "cancel" || opened.type === "dismiss") return;
      }
      // Silence unused-var lint for `filename` on web-only paths.
      void filename;
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("[recon-pdf] preview failed:", e);
      try {
        const backend = process.env.EXPO_PUBLIC_BACKEND_URL;
        const token = await storage.secureGet<string>(TOKEN_KEY, "");
        const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
        if (cacheDir && sub) {
          const target = `${cacheDir}reconditioning_${sub.reference || sub.id}.pdf`;
          const dl = await FileSystem.downloadAsync(
            `${backend}/api/submissions/${sub.id}/reconditioning.pdf`,
            target,
            { headers: token ? { Authorization: `Bearer ${token}` } : undefined }
          );
          if (dl.status >= 200 && dl.status < 300) {
            const canShare = await Sharing.isAvailableAsync();
            if (canShare) {
              await Sharing.shareAsync(dl.uri, {
                mimeType: "application/pdf",
                dialogTitle: "Reconditioning Sheet",
                UTI: "com.adobe.pdf",
              });
              return;
            }
          }
        }
      } catch (fallbackErr) {
        // eslint-disable-next-line no-console
        console.error("[recon-pdf] fallback share failed:", fallbackErr);
      }
      Alert.alert(
        "Preview failed",
        e?.message ? String(e.message) : "Could not open the reconditioning sheet. Please try again."
      );
    } finally {
      setDownloadingRecon(false);
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
    // "Expired" branch — sub was fetched and came back 404 (retention
    // window elapsed / archived). Show a friendly notice instead of
    // silently redirecting or leaving the previously-viewed vehicle
    // stuck on screen.
    if (expired) {
      return (
        <SafeAreaView style={styles.safe} edges={["top"]}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>Submission expired</Text>
            <BrandLogo size="xs" linkToHome />
          </View>
          <View style={[styles.center, { padding: spacing.lg, gap: spacing.md }]} testID="submission-expired-state">
            <Ionicons name="time-outline" size={44} color={colors.textDisabled} />
            <Text style={{ color: colors.text, fontSize: 18, fontWeight: "800", textAlign: "center" }}>
              This submission has expired
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: "center", lineHeight: 19, maxWidth: 420 }}>
              The record is no longer available — its retention window
              has elapsed or it was archived by an admin. To view an
              updated valuation, please re-submit the vehicle.
            </Text>
            <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm, flexWrap: "wrap", justifyContent: "center" }}>
              <TouchableOpacity
                testID="expired-download-pdf"
                onPress={async () => {
                  // Download the last-known-good snapshot. The backend
                  // stamps a red "SUBMISSION EXPIRED" banner on page 1
                  // so the dealer never mistakes this for a live doc.
                  try {
                    // IMPORTANT: use TOKEN_KEY (== "app.auth.token"), NOT
                    // the literal "token" — the auth key was previously
                    // wrong here which caused every archived-PDF fetch
                    // to hit the backend without an Authorization header
                    // and receive a 401.
                    const token = await storage.getItem(TOKEN_KEY);
                    const base = process.env.EXPO_PUBLIC_BACKEND_URL || "";
                    const fetchUrl = `${base}/api/submissions/${id}/valuation.pdf`;
                    const res = await fetch(fetchUrl, {
                      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                    });
                    if (!res.ok) throw new Error(`Server returned ${res.status}`);
                    const blob = await res.blob();
                    if (Platform.OS === "web") {
                      const dl = URL.createObjectURL(blob);
                      const a = (globalThis as any).document?.createElement?.("a");
                      if (a) {
                        a.href = dl;
                        a.download = `valuation_${id}_expired.pdf`;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(dl), 60_000);
                      }
                    } else {
                      // Native: write the blob to the cache dir as a
                      // real .pdf and hand it to the OS viewer / share
                      // sheet. We can't rely on `Linking.openURL` for
                      // the raw API URL because it wouldn't carry the
                      // Authorization header.
                      const b64: string = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
                        reader.onerror = () => reject(reader.error);
                        reader.readAsDataURL(blob);
                      });
                      const path = `${FileSystem.cacheDirectory}valuation_${id}_expired.pdf`;
                      await FileSystem.writeAsStringAsync(path, b64, { encoding: FileSystem.EncodingType.Base64 });
                      await WebBrowser.openBrowserAsync(path);
                    }
                  } catch (err: any) {
                    Alert.alert("Could not download PDF", err?.message || "Please try again shortly.");
                  }
                }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingHorizontal: 18,
                  paddingVertical: 10,
                  borderRadius: radius.sm,
                  borderWidth: 1,
                  borderColor: "#E31C24",
                }}
                accessibilityRole="button"
              >
                <View style={{ backgroundColor: "#E31C24", paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4 }}>
                  <Text style={{ color: "#fff", fontSize: 10, fontWeight: "800", letterSpacing: 1 }}>PDF</Text>
                </View>
                <Text style={{ color: "#E31C24", fontWeight: "800" }}>Download snapshot</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => router.push("/(app)/submit" as any)}
                style={{ paddingHorizontal: 18, paddingVertical: 10, borderRadius: radius.sm, backgroundColor: colors.primary }}
                accessibilityRole="button"
              >
                <Text style={{ color: colors.onPrimary, fontWeight: "800" }}>Re-submit vehicle</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => router.back()}
                style={{ paddingHorizontal: 18, paddingVertical: 10, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border }}
                accessibilityRole="button"
              >
                <Text style={{ color: colors.text, fontWeight: "700" }}>Go back</Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      );
    }
    // Loading state OR "no submission yet" — split into a proper error
    // card when the initial load failed so the user gets a clear
    // "something went wrong" affordance with Retry + Back buttons
    // instead of getting silently bounced to the home screen.
    if (loadError) {
      return (
        <SafeAreaView style={styles.safe} edges={["top"]}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>Vehicle</Text>
            <BrandLogo size="xs" linkToHome />
          </View>
          <View style={[styles.center, { padding: spacing.lg, gap: spacing.md }]}>
            <Ionicons name="alert-circle-outline" size={40} color={colors.textDisabled} />
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: "800", textAlign: "center" }}>
              We couldn&apos;t load this vehicle
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: "center", lineHeight: 19 }}>
              {loadError}
            </Text>
            <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
              <TouchableOpacity
                onPress={() => { setLoading(true); loadSub(); }}
                style={{ paddingHorizontal: 18, paddingVertical: 10, borderRadius: radius.sm, backgroundColor: colors.primary }}
              >
                <Text style={{ color: colors.onPrimary, fontWeight: "800" }}>Retry</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => router.back()}
                style={{ paddingHorizontal: 18, paddingVertical: 10, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border }}
              >
                <Text style={{ color: colors.text, fontWeight: "700" }}>Go back</Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      );
    }
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="detail-back-button"
          onPress={() => {
            // In cover-mode always route back to the Give Cover listing
            // (Cover given tab) — expo-router's `router.back()` on web
            // sometimes falls back to `/` when history is limited, which
            // felt like the app was "kicking" the pricing agent home.
            if (isCoverMode) {
              router.replace({ pathname: "/(app)/cover", params: { tab: "given" } });
              return;
            }
            router.back();
          }}
          style={styles.backBtn}
        >
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

      <KeyboardAwareScrollView
        ref={scrollRef as any}
        contentContainerStyle={[styles.scroll, isCoverMode && { paddingBottom: 220 }]}
        keyboardShouldPersistTaps="handled"
        // Keep the focused TextInput 24px above the keyboard so the
        // "My Offer" amount is visible while the dealer is typing.
        bottomOffset={24}
      >
        {/* Dealer branding banner — WhatsApp Business-style header with
            cover photo + circular profile pic + submitter name + the
            dealership they belong to. Shown in EVERY viewer mode
            (owner, admin AND pricing agent) so the network can see who
            they're pricing the vehicle for. */}
        {sub.submitter_cover_photo || sub.submitter_profile_pic || sub.submitted_by_name ? (
          <View style={styles.dealerBanner} testID="dealer-banner">
            <View style={styles.dealerBannerCoverClip}>
              {sub.submitter_cover_photo ? (
                <Image
                  source={{ uri: sub.submitter_cover_photo }}
                  style={styles.dealerBannerCover}
                  resizeMode="cover"
                />
              ) : (
                <View style={styles.dealerBannerCoverEmpty}>
                  <Ionicons name="business-outline" size={22} color={colors.textDisabled} />
                </View>
              )}
            </View>
            <View style={styles.dealerBannerAvatarWrap}>
              {sub.submitter_profile_pic ? (
                <Image
                  source={{ uri: sub.submitter_profile_pic }}
                  style={styles.dealerBannerAvatar}
                />
              ) : (
                <View style={styles.dealerBannerAvatarFallback}>
                  <Ionicons name="person" size={22} color={colors.primary} />
                </View>
              )}
            </View>
            <View style={styles.dealerBannerBody}>
              {sub.submitted_by_name ? (
                <Text style={styles.dealerBannerName} numberOfLines={1}>
                  {sub.submitted_by_name}
                  {sub.submitted_by_job_title ? (
                    <Text style={styles.dealerBannerJob}> · {sub.submitted_by_job_title}</Text>
                  ) : null}
                </Text>
              ) : null}
              {sub.company_name ? (
                <Text style={styles.dealerBannerCompany} numberOfLines={1}>
                  <Ionicons name="briefcase-outline" size={12} color={colors.textSecondary} />
                  {" "}{sub.company_name}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}

        {/* Unseen banner — loud red warning shown to both dealers and admins
            immediately at the top of the vehicle detail so the "Cover Price"
            below is never mistaken for an inspection-backed number. */}
        {sub.unseen ? (
          <View style={styles.unseenBanner} testID="unseen-banner">
            <Ionicons name="eye-off-outline" size={16} color={colors.textSecondary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.unseenBannerTitle}>Subject to View — Less to Spend</Text>
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

        {/* Hero title — MAKE + DERIVATIVE. The derivative already
            embeds the model name so the model line would be redundant.
            Rendered as a bold hero block with a coloured left accent so
            it stands out as THE identity of the submission. */}
        <View style={styles.titleBox} testID="vehicle-hero-title">
          <View style={styles.titleAccent} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.brand} testID="vehicle-hero-make">{sub.make_name}</Text>
            {sub.derivative_name ? (
              <Text style={styles.derivative} numberOfLines={2} testID="vehicle-hero-derivative">
                {sub.derivative_name}
              </Text>
            ) : null}
            {sub.year ? (
              <Text style={styles.titleYear}>
                {sub.year}
                {typeof sub.mileage === "number" ? (
                  <Text style={styles.titleYearSep}>  ·  </Text>
                ) : null}
                {typeof sub.mileage === "number"
                  ? `${sub.mileage.toLocaleString("en-ZA")} km`
                  : ""}
              </Text>
            ) : null}
          </View>
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
          <DetailRow
            label="Mileage"
            value={
              typeof sub.mileage === "number" && Number.isFinite(sub.mileage)
                ? `${sub.mileage.toLocaleString()} km`
                : "—"
            }
          />
          <DetailRow label="Transmission" value={sub.transmission ?? "—"} />
          <DetailRow label="Fuel Type" value={sub.fuel_type ?? "—"} />
          <DetailRow label="Colour" value={sub.colour} />
          {sub.variant_manufacture_range && sub.variant_manufacture_range.min && sub.variant_manufacture_range.max ? (
            <DetailRow
              label="Model Year Run"
              value={
                sub.variant_manufacture_range.min === sub.variant_manufacture_range.max
                  ? String(sub.variant_manufacture_range.min)
                  : `${sub.variant_manufacture_range.min} – ${sub.variant_manufacture_range.max}`
              }
            />
          ) : null}
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

        {/* Status banner — hidden in cover-mode so pricing agents aren't
            anchored by any Fourbuy offer/price state. */}
        {isCoverMode ? null : sub.status === "priced" ? (
          <View style={styles.fourbuyOfferCard} testID="fourbuy-offer-card">
            <View style={styles.priceBanner} testID="price-banner">
              <View>
                <Text style={styles.priceLabel}>FOURBUY OFFER</Text>
                <Text style={styles.priceValue}>{formatZAR(sub.price)}</Text>
                {sub.price_notes ? <Text style={styles.priceNotes}>{sub.price_notes}</Text> : null}
              </View>
              <Ionicons name="checkmark-circle" size={40} color={colors.text} />
            </View>

            {/* Nested Fourbuy Offer History — sits inside the same card
                as the FOURBUY OFFER banner so the audit trail is
                visually tied to the current offer. Collapsible, closed
                by default. */}
            {sub.price_history && sub.price_history.length > 0 ? (
              <View style={styles.nestedHistory} testID="price-history">
                <TouchableOpacity
                  testID="price-history-toggle"
                  style={styles.nestedHistoryToggle}
                  onPress={() => setPriceHistoryOpen((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={
                    priceHistoryOpen ? "Collapse offer history" : "Expand offer history"
                  }
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
                    <Text style={styles.nestedHistoryTitle}>
                      Fourbuy Offer History ({sub.price_history.length})
                    </Text>
                  </View>
                  <Ionicons
                    name={priceHistoryOpen ? "chevron-up" : "chevron-down"}
                    size={16}
                    color={colors.textSecondary}
                  />
                </TouchableOpacity>
                {priceHistoryOpen ? (
                  <View style={styles.nestedHistoryBody}>
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
              </View>
            ) : null}
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

        {/* Cover Offers Received — binding offers placed by Pricing Agents
            on this submission. Visible to the owning dealer + admins only
            (the backend simply returns [] to everyone else). Each row
            shows the agent's name, dealership, cover price, and a
            WhatsApp CTA that opens a chat pre-filled with the vehicle
            reference. Sorted by price desc by the backend.

            The panel is collapsible so it doesn't hog the top of the
            page — closed by default. When closed, we still show a peek
            of the HIGHEST cover so the dealer knows the top of the
            market at a glance without opening the panel. */}
        {coverOffers.length > 0 && !isCoverMode ? (
          <View style={styles.coverOffersBox} testID="cover-offers-received">
            <TouchableOpacity
              testID="cover-offers-toggle"
              style={styles.coverOffersHeader}
              onPress={() => setCoverOffersOpen((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={
                coverOffersOpen ? "Collapse cover offers" : "Expand cover offers"
              }
            >
              <Ionicons name="shield-checkmark" size={18} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.coverOffersTitle}>
                  Cover Offers Received ({coverOffers.length})
                </Text>
                {!coverOffersOpen && coverOffers[0] ? (
                  // Backend already sorts DESC by price so `[0]` is
                  // the highest. Render it as a compact single-line
                  // "peek" — dealer opens the panel for the full list.
                  <Text style={styles.coverOffersPeek} numberOfLines={1}>
                    Top: <Text style={{ color: colors.text, fontWeight: "800" }}>
                      R{coverOffers[0].price_zar.toLocaleString()}
                    </Text>
                    {coverOffers[0].agent_name
                      ? ` · ${coverOffers[0].agent_name}`
                      : ""}
                    {coverOffers[0].agent_dealership_name
                      ? ` · ${coverOffers[0].agent_dealership_name}`
                      : ""}
                  </Text>
                ) : null}
              </View>
              <Ionicons
                name={coverOffersOpen ? "chevron-up" : "chevron-down"}
                size={18}
                color={colors.textSecondary}
              />
            </TouchableOpacity>
            {coverOffersOpen ? (
              <>
                <Text style={styles.coverOffersSub}>
                  Binding Cover from Registered Dealer · subject to physical inspection.
                </Text>
                {coverOffers.map((c, idx) => {
                  const phoneDigits = (c.agent_phone || "").replace(/[^0-9]/g, "");
                  // South-African local numbers → E.164 for wa.me (drop leading 0, add 27).
                  const waNumber =
                    phoneDigits.startsWith("27")
                      ? phoneDigits
                      : phoneDigits.startsWith("0")
                        ? "27" + phoneDigits.slice(1)
                        : phoneDigits;
                  const waMessage = encodeURIComponent(
                    `Hi ${c.agent_name || "there"}, this is regarding your cover of R${c.price_zar.toLocaleString()} on ${sub.reference || "our vehicle"} (${[sub.make_name, sub.derivative_name || sub.model_name].filter(Boolean).join(" ")}).`
                  );
                  const waUrl = waNumber ? `https://wa.me/${waNumber}?text=${waMessage}` : null;
                  return (
                    <View
                      key={c.id}
                      style={[
                        styles.coverOfferRow,
                        idx === coverOffers.length - 1 && { borderBottomWidth: 0 },
                      ]}
                      testID={`cover-offer-${c.id}`}
                    >
                      {/* Round profile photo (or fallback initial disc) so
                          the dealer instantly recognises the pricing
                          agent placing the cover. */}
                      {c.agent_profile_pic ? (
                        <Image
                          source={{ uri: c.agent_profile_pic }}
                          style={styles.coverOfferAvatar}
                          resizeMode="cover"
                        />
                      ) : (
                        <View style={styles.coverOfferAvatarFallback}>
                          <Text style={styles.coverOfferAvatarInitial}>
                            {(c.agent_name || "?").trim().charAt(0).toUpperCase()}
                          </Text>
                        </View>
                      )}
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.coverOfferPrice}>
                          R{c.price_zar.toLocaleString()}
                        </Text>
                        <Text style={styles.coverOfferAgent} numberOfLines={1}>
                          {c.agent_name || "Pricing agent"}
                          {c.agent_dealership_name ? ` · ${c.agent_dealership_name}` : ""}
                        </Text>
                        <Text style={styles.coverOfferDate}>
                          {new Date(c.created_at).toLocaleString()}
                        </Text>
                        {c.note ? (
                          <Text style={styles.coverOfferNote}>{c.note}</Text>
                        ) : null}
                      </View>
                      {waUrl ? (
                        <TouchableOpacity
                          testID={`cover-offer-whatsapp-${c.id}`}
                          style={styles.whatsappBtn}
                          onPress={() => {
                            if (Platform.OS === "web") {
                              (globalThis as any).window?.open?.(waUrl, "_blank");
                            } else {
                              Linking.openURL(waUrl).catch(() => {});
                            }
                          }}
                        >
                          <Ionicons name="logo-whatsapp" size={18} color="#fff" />
                          <Text style={styles.whatsappBtnText}>WhatsApp</Text>
                        </TouchableOpacity>
                      ) : c.agent_phone ? (
                        <Text style={styles.coverOfferPhone}>{c.agent_phone}</Text>
                      ) : null}
                    </View>
                  );
                })}
                {/* Legal / trust disclaimer — reinforces to the dealer
                    that the cover is subject to a physical inspection
                    and that they should confirm directly with the
                    registered dealer before finalising the deal. */}
                <View style={styles.coverOffersDisclaimer} testID="cover-offers-disclaimer">
                  <Ionicons
                    name="information-circle"
                    size={14}
                    color={colors.textSecondary}
                    style={{ marginTop: 1 }}
                  />
                  <Text style={styles.coverOffersDisclaimerText}>
                    All Cover Prices are subject to a physical inspection of the vehicle to ensure the vehicle is as per the valuation — please always confirm the cover with the dealer prior to going ahead with the deal.
                  </Text>
                </View>
              </>
            ) : null}
          </View>
        ) : null}

        {/* Deal Tracking has been moved to the very bottom of the scroll
            content — see below, after Market Values. */}



        {/* Fourbuy Offer History is now nested INSIDE the Fourbuy Offer
            card above — see `fourbuyOfferCard`. This standalone slot
            is intentionally left blank so the layout below stays
            unchanged. */}

        {/* Open Valuation PDF — always available once an offer has been received.
            Hidden in cover mode because the PDF exposes the Fourbuy admin offer. */}
        {sub.status === "priced" && !isCoverMode ? (
          <View style={styles.reportsSection}>
            <TouchableOpacity
              testID="download-valuation-pdf"
              style={[styles.docBtn, downloadingPdf && styles.docBtnDisabled]}
              onPress={handleDownloadPdf}
              disabled={downloadingPdf}
            >
              <View style={styles.docBtnLeft}>
                <View style={styles.pdfBadge}>
                  <Text style={styles.pdfBadgeText}>PDF</Text>
                </View>
                <View style={{ marginLeft: spacing.sm, flex: 1 }}>
                  <Text style={styles.docBtnTitle}>Download Valuation PDF</Text>
                  <Text style={styles.docBtnSubtitle}>
                    Includes offer, condition, tyre estimate & any purchased reports
                  </Text>
                </View>
              </View>
              {downloadingPdf ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Ionicons name="download-outline" size={22} color="#E31C24" />
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
                ["Date of Test", info.dateOfTest],
                ["Expires", info.expiryDate],
                ["Disc No", info.licenceDiscNo],
              ];
              // Ownership signal derived from the disc's Date of Test:
              //   • blank test date → 1-Owner from new (car has never
              //     been re-registered, so no roadworthy test needed).
              //   • present test date → approx. ownership duration
              //     between last roadworthy test and this valuation.
              // Both variants are highlighted with a strong badge so
              // the indicator stands out from the rest of the disc data.
              const submittedAtIso = sub.created_at || new Date().toISOString();
              let ownership: { text: string; oneOwner: boolean } | null = null;
              if (!info.dateOfTest) {
                ownership = { text: "1-Owner from new", oneOwner: true };
              } else {
                try {
                  const test = new Date(info.dateOfTest);
                  const now = new Date(submittedAtIso);
                  let months =
                    (now.getFullYear() - test.getFullYear()) * 12 +
                    (now.getMonth() - test.getMonth());
                  if (now.getDate() < test.getDate()) months -= 1;
                  if (months < 0) months = 0;
                  const yrs = Math.floor(months / 12);
                  const mos = months % 12;
                  const parts: string[] = [];
                  if (yrs > 0) parts.push(`${yrs} ${yrs === 1 ? "year" : "years"}`);
                  if (mos > 0 || yrs === 0) parts.push(`${mos} ${mos === 1 ? "month" : "months"}`);
                  ownership = { text: `Owned approx. ${parts.join(" ")}`, oneOwner: false };
                } catch {
                  ownership = null;
                }
              }
              return (
                <View style={styles.diskDecodedBox}>
                  {ownership ? (
                    <View
                      style={[
                        styles.ownershipBadge,
                        ownership.oneOwner ? styles.ownershipBadgeOne : styles.ownershipBadgeMulti,
                      ]}
                      testID="license-disk-ownership-badge"
                    >
                      <Ionicons
                        name={ownership.oneOwner ? "ribbon" : "time-outline"}
                        size={16}
                        color={ownership.oneOwner ? "#065F46" : colors.text}
                      />
                      <Text
                        style={[
                          styles.ownershipBadgeText,
                          ownership.oneOwner
                            ? styles.ownershipBadgeTextOne
                            : styles.ownershipBadgeTextMulti,
                        ]}
                      >
                        {ownership.text}
                      </Text>
                    </View>
                  ) : null}
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
            inspection). We still render a special 10/10 "Subject to
            View — Less to Spend" hero below so the valuation makes
            clear it is priced as-if-perfect. */}
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

        {/* Subject-to-View condition hero — replaces the normal Condition
            widget when the vehicle was submitted unseen. Displays a
            constant 10.0 / 10 to communicate "priced as-if-perfect
            condition" (dealer hasn't inspected the car), with a soft
            "Subject to View — Less to Spend" caption. */}
        {sub.unseen ? (
          <View style={styles.heroBox} testID="unseen-condition-hero">
            <View style={styles.heroTopRow}>
              <Text style={styles.heroLabel}>OVERALL CONDITION</Text>
              <View style={styles.heroInfoBtn}>
                <Ionicons name="eye-off-outline" size={13} color={colors.textSecondary} />
                <Text style={styles.heroInfoText}>Subject to View</Text>
              </View>
            </View>
            <View style={styles.heroRow}>
              <Text style={styles.heroValue}>10.0</Text>
              <Text style={styles.heroOutOf}>/ 10</Text>
            </View>
            <View style={styles.heroBar}>
              <View style={[styles.heroBarFill, { width: "100%" }]} />
            </View>
            <Text style={styles.unseenHeroCaption}>
              Subject to View — Less to Spend · Priced as-if-perfect condition. Adjusts on physical inspection.
            </Text>
          </View>
        ) : null}

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

        {/* Warranty, Maintenance Plan & Service Plan — dealer answer at valuation stage */}
        {!sub.unseen && (sub.factory_warranty_status || sub.maintenance_plan_status || sub.service_plan_status || sub.factory_warranty !== undefined) ? (
          <>
            <Text style={styles.sectionTitle}>Warranty, Maintenance &amp; Service Plan</Text>
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
                    />
                    <DetailRow
                      label="Service Plan"
                      value={label(sub.service_plan_status)}
                      valueColor={colour(sub.service_plan_status)}
                      last
                    />
                  </>
                );
              })()}
            </View>
          </>
        ) : null}

        {/* AI Market Analysis — collapsed by default. The section
            header ships a "Refresh"/"Analyse" action on the right, and
            a one-line summary chip when collapsed so dealers can see
            at a glance whether an analysis has been generated. */}
        <CollapsibleSection
          title="AI Market Analysis"
          open={isOpen("ai")}
          onToggle={() => toggleSection("ai")}
          summary={
            sub.market_analysis?.analysis?.estimated_market_range_zar
              ? `R ${sub.market_analysis.analysis.estimated_market_range_zar.low.toLocaleString()} — R ${sub.market_analysis.analysis.estimated_market_range_zar.high.toLocaleString()}`
              : (sub.market_analysis?.generated_at ? "Analysis ready" : "Not yet analysed")
          }
          right={
            <TouchableOpacity
              testID="market-analysis-button"
              style={[styles.analysisBtn, analysing && { opacity: 0.6 }]}
              onPress={(e) => { e.stopPropagation?.(); handleMarketAnalysis(); }}
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
          }
          colors={colors}
          styles={styles}
          testID="ai-market-analysis"
        >
          {sub.market_analysis?.generated_at ? (
            <Text style={[styles.analysisTs, { marginBottom: spacing.sm }]}>
              Generated {new Date(sub.market_analysis.generated_at).toLocaleString()}
            </Text>
          ) : null}

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

            {sub.market_analysis.analysis.year_positioning ? (
              <View style={styles.factorsBox}>
                <Text style={styles.factorsTitle}>YEAR POSITIONING</Text>
                <Text style={styles.factorText}>
                  {sub.market_analysis.analysis.year_positioning}
                </Text>
              </View>
            ) : null}

            {sub.market_analysis.analysis.mileage_positioning ? (
              <View style={styles.factorsBox}>
                <Text style={styles.factorsTitle}>MILEAGE POSITIONING</Text>
                <Text style={styles.factorText}>
                  {sub.market_analysis.analysis.mileage_positioning}
                </Text>
              </View>
            ) : null}

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
        </CollapsibleSection>

        {/* Compare Live Listings — deep-links into AutoTrader AND
            WeBuyCars search results pre-filtered to comparable stock.
            Collapsible so it doesn't stretch the valuation page. Two
            reference markets are surfaced side-by-side: AutoTrader
            (broad dealer + private listing pool) and WeBuyCars
            (reconditioned retail stock, useful as an upper bound). */}
        <CollapsibleSection
          title="Compare Live Listings"
          open={isOpen("live-listings")}
          onToggle={() => toggleSection("live-listings")}
          summary="Same-derivative results on AutoTrader + WeBuyCars"
          colors={colors}
          styles={styles}
          testID="compare-listings"
        >
          {/* Responsive 2-column layout — the AutoTrader and WeBuyCars
              cards read as siblings of equal weight. On phones they
              stack vertically as before. On web / tablet each takes
              50% of the available width. */}
          <View style={styles.compareCardsRow}>
            <ComparableListingsCard
              make={sub.make_name}
              model={sub.model_name}
              derivative={sub.derivative_name}
              fuelType={sub.fuel_type}
              transmission={sub.transmission}
              year={sub.year_of_production ?? sub.year}
              yearFrom={sub.variant_manufacture_range?.min ?? null}
              yearTo={sub.variant_manufacture_range?.max ?? null}
            />
            <WeBuyCarsListingsCard
              make={sub.make_name}
              model={sub.model_name}
              derivative={sub.derivative_name}
              fuelType={sub.fuel_type}
              transmission={sub.transmission}
              year={sub.year_of_production ?? sub.year}
              yearFrom={sub.variant_manufacture_range?.min ?? null}
              yearTo={sub.variant_manufacture_range?.max ?? null}
            />
          </View>
          {/* Combined advisory across both markets — explains how to
              interpret the two data sources side-by-side. */}
          <View style={styles.compareAdvisory} testID="compare-listings-advisory">
            <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.compareAdvisoryText}>
              <Text style={{ fontWeight: "700", color: colors.text }}>AutoTrader</Text> shows
              listings from reputable dealers (3★+) — typically reconditioned and warrantied,
              so treat them as the retail ceiling.{"  "}
              <Text style={{ fontWeight: "700", color: colors.text }}>WeBuyCars</Text> shows
              stock in mixed condition and NOT reconditioned — closer to trade / wholesale,
              but condition varies listing-to-listing.{"  "}
              It is advised that you go through the listings carefully before drawing a
              conclusion.
            </Text>
          </View>
        </CollapsibleSection>

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

        {/* VIN-linked Reports — order or view. Collapsible; opens by
            default because ordering is a primary dealer action.
            IMPORTANT: this section is available REGARDLESS of the
            submission's pricing status. Business rule (2026-08-10):
            the owning dealer must be able to spend on VIN reports
            the instant they've loaded the car; Fourbuy's pricing
            turnaround shouldn't block dealer workflow. */}
        {true ? (
          <CollapsibleSection
            title={isAdmin || isCoverMode ? "VIN-Linked Reports" : "Order a VIN-Linked Report"}
            open={isOpen("reports")}
            onToggle={() => toggleSection("reports")}
            summary={
              (sub.report_orders || []).filter((r) => r.type !== "cover_offer").length > 0
                ? `${(sub.report_orders || []).filter((r) => r.type !== "cover_offer").length} report${(sub.report_orders || []).filter((r) => r.type !== "cover_offer").length === 1 ? "" : "s"} ordered`
                : ((isAdmin || isCoverMode) ? "No reports ordered yet" : "Tap to view available reports")
            }
            colors={colors}
            styles={styles}
            testID="reports-section"
          >
        {/* VIN-linked report ordering — only when a VIN was entered/scanned.
                Admins never see the "Order" buttons: they can only view reports
                the dealer has already ordered. */}
            {sub.vin && sub.vin.trim() && sub.vin.toUpperCase() !== "TBC" ? (
              <>
                {isAdmin || isCoverMode ? (
                  // Admin / cover-mode: no ordering UI. Show reports the
                  // owning dealer has already purchased, or a small hint
                  // that none have been ordered yet.
                  (sub.report_orders || []).length > 0 ? (
                    <>
                      <Text style={styles.reportsSubhead}>
                        {isCoverMode ? "VIN reports ordered by the seller" : "VIN reports ordered by dealer"}
                      </Text>
                      <Text style={styles.reportsHelp}>
                        Verified against VIN {sub.vin}.
                        {isCoverMode
                          ? " Pricing agents can view results but cannot order new reports."
                          : " Admins can view results but cannot order reports on behalf of a dealer."}
                      </Text>
                    </>
                  ) : (
                    <View style={styles.adminNoReports}>
                      <Ionicons name="lock-closed-outline" size={16} color={colors.textDisabled} />
                      <Text style={styles.adminNoReportsText}>
                        {isCoverMode
                          ? "The seller has not purchased any VIN-linked reports yet."
                          : "VIN reports can only be ordered by the dealer. None purchased yet."}
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
                    // Kredo accident / claim history — available for every
                    // VIN. Included in this unified list so ordering, cost
                    // display and viewing behave identically to every
                    // other VIN-linked report.
                    if (sub.vin && sub.vin.trim() && sub.vin.toUpperCase() !== "TBC") {
                      baseTypes.push("kredo_vin_history");
                    }
                    return baseTypes;
                  })()
                  .filter((t) => (!isAdmin && !isCoverMode) || orderedReportTypes.has(t))
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
                    (see orderCartrust / cartrust state above). Admins see
                    the card only when the dealer has already ordered it —
                    admins cannot order CarTrust on behalf of a dealer. */}
                {((!isAdmin && !isCoverMode) || cartrust) ? (
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
                    ) : !isAdmin && !isCoverMode ? (
                      // Order button — dealer only. Admins never see this
                      // (the card as a whole is hidden until the dealer
                      // has an active/completed order).
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
                    ) : null}
                  </View>
                ) : null}
              </>
            ) : (
              // No VIN → the dealer hasn't scanned the license disk yet.
              // VIN-linked reports (Lightstone, Kredo, CarTrust, JLR OSH,
              // BMW options, CarVertical) all require a VIN, so surface a
              // clear explainer with a shortcut back to the scan flow.
              <View style={styles.vinRequiredBox} testID="vin-required-notice">
                <Ionicons name="scan-outline" size={20} color={colors.textSecondary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.vinRequiredTitle}>License disk required</Text>
                  <Text style={styles.vinRequiredHint}>
                    The VIN-Linked report requires you to capture the license
                    disk. Scan it to unlock Lightstone, Kredo accident history,
                    CarTrust and factory-option reports. Won&apos;t create a
                    new billable valuation.
                  </Text>
                  {!isAdmin && !isCoverMode ? (
                    <TouchableOpacity
                      testID="scan-license-disk-cta"
                      style={styles.vinRequiredBtn}
                      onPress={() => router.push({
                        pathname: "/(app)/scan",
                        params: { returnPath: "attachDisk", submissionId: sub.id },
                      } as any)}
                      accessibilityRole="button"
                    >
                      <Ionicons name="scan" size={14} color={colors.onPrimary} />
                      <Text style={styles.vinRequiredBtnText}>Capture license disk</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            )}
          </CollapsibleSection>
        ) : null}

        {/* CarTrust PDF ordering is now rendered inline in the "Order a
            VIN-Linked Report" section above — the standalone card was
            removed at the user's request. */}

        {/* Kredo VIN accident / claim history is also now rendered
            inline in the unified "Order a VIN-Linked Report" section
            above so ordering, cost display (R100), pending/delivered
            pill and the View modal are visually consistent with every
            other VIN-linked report. The standalone panel that lived
            here previously has been retired. */}

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
                  setPriceInput(sub.price ? formatMoneyString(String(sub.price)) : "");
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

        {/* ==================== DEALER OFFER CARD ====================
            Standalone card visible to every user on the owning
            dealership (and to admins). Displays the current dealer
            offer for the vehicle. Only managerial (`is_pricing_agent`)
            users can enter / update it. Once an offer is captured,
            the Deal Tracking section below unlocks.

            Hidden in cover-mode (pricing agents inspecting other
            dealerships' submissions must never see the local dealer
            offer). Now VISIBLE while the vehicle is still pending —
            business rule (2026-08-10): the owning dealership must
            be able to commit their own offer the moment the car is
            loaded, without waiting on Fourbuy's pricing turnaround.
        */}
        {!isCoverMode && (isAdmin || isOwningDealer) ? (
          (() => {
            const deal = (sub as any).deal as DealInfo | null | undefined;
            const savedOffer = deal?.dealer_offer_zar ?? null;
            const canEditOffer = !isAdmin && isOwningDealer && !!((user as any)?.is_pricing_agent);
            const parsed = parseMoneyInput(dealOfferInput);
            const isDirty = parsed !== savedOffer && parsed != null;
            const offerHistory = ((deal?.dealer_offer_history || []) as {
              price_zar: number;
              at: string;
              by_name?: string;
            }[]).slice().reverse(); // newest first
            return (
              <View style={styles.dealerOfferCard} testID="dealer-offer-card">
                <View style={styles.dealerOfferHeader}>
                  <Ionicons name="cash-outline" size={16} color={colors.text} />
                  <Text style={styles.dealerOfferTitle}>{isAdmin ? "Dealer Offer" : "My Offer"}</Text>
                  {savedOffer != null ? (
                    <View style={styles.dealerOfferPill} testID="dealer-offer-set-pill">
                      <Ionicons name="checkmark-circle" size={11} color="#fff" />
                      <Text style={styles.dealerOfferPillText}>OFFER SET</Text>
                    </View>
                  ) : (
                    <View style={[styles.dealerOfferPill, { backgroundColor: colors.textDisabled }]}>
                      <Text style={styles.dealerOfferPillText}>NOT SET</Text>
                    </View>
                  )}
                </View>
                {savedOffer != null ? (
                  <Text style={styles.dealerOfferBigNumber} testID="dealer-offer-amount">
                    {fmtZar(savedOffer)}
                  </Text>
                ) : null}
                {savedOffer != null && deal?.dealer_offer_at ? (
                  <Text style={styles.dealerOfferMeta}>
                    Recorded {new Date(deal.dealer_offer_at).toLocaleDateString()}
                  </Text>
                ) : null}
                <Text style={styles.dealerOfferHelp}>
                  {canEditOffer
                    ? "Your dealership's own offer to the seller. Save this to unlock the Deal Tracking section below."
                    : savedOffer != null
                      ? (isAdmin
                          ? "This is the offer the dealership's manager has recorded for the seller."
                          : "This is the offer your dealership's manager has recorded for the seller.")
                      : (isAdmin
                          ? "Waiting on the dealership's manager to record the offer."
                          : "Waiting on your dealership's manager to record the offer.")}
                </Text>
                {canEditOffer ? (
                  <View style={styles.dealerOfferInputRow}>
                    <TextInput
                      testID="dealer-offer-input"
                      value={dealOfferInput}
                      onChangeText={(v) => setDealOfferInput(formatMoneyString(v))}
                      placeholder="e.g. 380,000"
                      placeholderTextColor={colors.textDisabled}
                      keyboardType="numeric"
                      editable={!dealSaving}
                      style={[styles.dealerOfferInput, { flex: 1 }]}
                    />
                    <TouchableOpacity
                      testID="dealer-offer-save"
                      disabled={dealSaving || !isDirty}
                      style={[
                        styles.dealerOfferSaveBtn,
                        (!isDirty || dealSaving) && { opacity: 0.5 },
                      ]}
                      onPress={() => patchDeal({ dealer_offer_zar: parsed })}
                    >
                      {dealSaving ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.dealerOfferSaveBtnText}>
                          {savedOffer != null ? "Update" : "Save Offer"}
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>
                ) : null}

                {/* Collapsible offer history — only shown when there
                    are at least 2 recorded amounts (i.e. the offer has
                    changed at least once). Ordered newest-first with
                    the current amount highlighted. */}
                {offerHistory.length >= 2 ? (
                  <TouchableOpacity
                    testID="dealer-offer-history-toggle"
                    onPress={() => setDealerOfferHistoryOpen((v) => !v)}
                    style={styles.dealerOfferHistoryToggle}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={dealerOfferHistoryOpen ? "chevron-up" : "chevron-down"}
                      size={13}
                      color={colors.textSecondary}
                    />
                    <Text style={styles.dealerOfferHistoryToggleText}>
                      {dealerOfferHistoryOpen ? "Hide" : "Show"} offer history · {offerHistory.length} update{offerHistory.length === 1 ? "" : "s"}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {offerHistory.length >= 2 && dealerOfferHistoryOpen ? (
                  <View style={styles.dealerOfferHistoryList} testID="dealer-offer-history-list">
                    {offerHistory.map((h, idx) => {
                      const isCurrent = idx === 0;
                      return (
                        <View
                          key={`${h.at}-${idx}`}
                          style={[
                            styles.dealerOfferHistoryRow,
                            isCurrent && { borderColor: colors.primary + "88" },
                          ]}
                        >
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.dealerOfferHistoryAmount}>
                              {fmtZar(h.price_zar)}
                              {isCurrent ? (
                                <Text style={{ color: colors.primary, fontWeight: "800" }}>  · Current</Text>
                              ) : null}
                            </Text>
                            <Text style={styles.dealerOfferHistoryMeta}>
                              {new Date(h.at).toLocaleString()} · {h.by_name || "—"}
                            </Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            );
          })()
        ) : null}

        {/* ==================== DEAL TRACKING ====================
            Access rules:
              • Visible to any user on the OWNING dealership (all
                colleagues can watch progress) AND to admins.
              • Visible ONLY after a dealer offer has been captured
                (the standalone "Dealer Offer" card above). Until then
                Deal Tracking is completely hidden — no empty prompts.
              • Only `is_pricing_agent` users on that dealership can
                EDIT — this toggle is the managerial-access marker.
                Everyone else sees the section read-only.
              • Defaults to "Pending" outcome; the managerial user
                confirms deal done / not done and completes the
                profit analysis as before.
            Hidden in cover-mode and while the vehicle is still pending.
        */}
        {!isCoverMode &&
        sub.status !== "pending" &&
        (isAdmin || isOwningDealer) &&
        (sub as any)?.deal?.dealer_offer_zar != null ? (
          (() => {
            const deal = (sub as any).deal as DealInfo | null | undefined;
            const profit = ((sub as any).deal_profit as DealProfit | null) || null;
            const done = dealDoneChoice === "yes";  // local live state
            const sold = dealSoldChoice === "yes";
            // Only a `is_pricing_agent` dealer on the owning dealership
            // can edit; every other viewer (colleague + admin) sees it
            // read-only. `isAdmin` stays read-only for oversight.
            const canEdit = !isAdmin && isOwningDealer && !!((user as any)?.is_pricing_agent);
            const readOnly = !canEdit;
            const canDownloadPdf = profit?.profit_zar != null;
            // Outcome pill mirrors the LIVE choice so it updates
            // instantly when the dealer taps a pill, before hitting
            // save.
            const outcome: "pending" | "deal_done" | "no_deal" =
              dealDoneChoice === "yes"
                ? "deal_done"
                : dealDoneChoice === "no"
                  ? "no_deal"
                  : "pending";
            const outcomeLabel =
              outcome === "deal_done"
                ? "DEAL DONE"
                : outcome === "no_deal"
                  ? "NO DEAL DONE"
                  : "PENDING OUTCOME";
            const outcomeStyle =
              outcome === "deal_done"
                ? styles.dealOutcomeOk
                : outcome === "no_deal"
                  ? styles.dealOutcomeNo
                  : styles.dealOutcomePending;
            const outcomeIcon: "checkmark-circle" | "close-circle" | "hourglass-outline" =
              outcome === "deal_done"
                ? "checkmark-circle"
                : outcome === "no_deal"
                  ? "close-circle"
                  : "hourglass-outline";
            return (
              <View style={styles.dealBox} testID="deal-tracking">
                <View style={styles.dealHeader}>
                  <Ionicons name="briefcase-outline" size={18} color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.dealTitle}>Deal Tracking &amp; Profit Analysis</Text>
                    <Text style={styles.dealSub}>
                      Private to your dealership and Fourbuy admin. Pricing
                      agents never see this.
                    </Text>
                  </View>
                  {readOnly ? (
                    <View style={styles.dealBadge}>
                      <Ionicons name="lock-closed" size={11} color={colors.textSecondary} />
                      <Text style={styles.dealBadgeText}>ADMIN VIEW</Text>
                    </View>
                  ) : null}
                </View>

                {/* Outcome status pill — surfaces the tri-state at a
                    glance for both the dealer AND admin. Will be shown
                    against this submission on the home-screen deal-
                    outcome report the user asked for. */}
                <View style={[styles.dealOutcomePill, outcomeStyle]} testID="deal-outcome">
                  <Ionicons name={outcomeIcon} size={14} color="#fff" />
                  <Text style={styles.dealOutcomePillText}>{outcomeLabel}</Text>
                </View>

                {/* ------ Stage 1: Purchase ------ */}
                <View style={styles.dealStage} testID="deal-stage-1">
                  <View style={styles.dealStageHeader}>
                    <View style={styles.dealStagePill}>
                      <Text style={styles.dealStagePillText}>1</Text>
                    </View>
                    <Text style={styles.dealStageTitle}>Did you do the deal?</Text>
                  </View>
                  <View style={styles.dealChoiceRow}>
                    <TouchableOpacity
                      testID="deal-done-pending"
                      disabled={readOnly || dealSaving}
                      style={[
                        styles.dealChoiceBtn,
                        dealDoneChoice === "pending" && styles.dealChoiceBtnPending,
                      ]}
                      onPress={() => setDealDoneChoice("pending")}
                    >
                      <Ionicons
                        name="hourglass-outline"
                        size={16}
                        color={dealDoneChoice === "pending" ? "#fff" : colors.textSecondary}
                      />
                      <Text
                        style={[
                          styles.dealChoiceBtnText,
                          dealDoneChoice === "pending" && styles.dealChoiceBtnTextActive,
                        ]}
                      >
                        Pending
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID="deal-done-yes"
                      disabled={readOnly || dealSaving}
                      style={[styles.dealChoiceBtn, done && styles.dealChoiceBtnYes]}
                      onPress={() => setDealDoneChoice("yes")}
                    >
                      <Ionicons name="checkmark-circle" size={16}
                        color={done ? "#fff" : colors.textSecondary} />
                      <Text style={[styles.dealChoiceBtnText, done && styles.dealChoiceBtnTextActive]}>Yes</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID="deal-done-no"
                      disabled={readOnly || dealSaving}
                      style={[styles.dealChoiceBtn, dealDoneChoice === "no" && styles.dealChoiceBtnNo]}
                      onPress={() => setDealDoneChoice("no")}
                    >
                      <Ionicons name="close-circle" size={16}
                        color={dealDoneChoice === "no" ? "#fff" : colors.textSecondary} />
                      <Text style={[styles.dealChoiceBtnText, dealDoneChoice === "no" && styles.dealChoiceBtnTextActive]}>No</Text>
                    </TouchableOpacity>
                  </View>
                  {done ? (
                    <View style={styles.dealField}>
                      <Text style={styles.dealFieldLabel}>Purchase price</Text>
                      <View style={styles.dealInputWrap}>
                        <Text style={styles.dealInputPrefix}>R</Text>
                        <TextInput
                          testID="deal-purchase-input"
                          style={styles.dealInput}
                          value={dealPurchaseInput}
                          onChangeText={(t) => setDealPurchaseInput(formatMoneyString(t))}
                          placeholder="0"
                          placeholderTextColor={colors.textDisabled}
                          keyboardType="numeric"
                          editable={!readOnly && !dealSaving}
                        />
                      </View>
                      {deal?.purchased_at ? (
                        <Text style={styles.dealMeta}>
                          Recorded {new Date(deal.purchased_at).toLocaleDateString()}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>

                {/* Reconditioning Requirement Sheet — the workshop
                    handoff. Placed just above Stage 2 (Have you sold
                    the car?) because reconditioning is done BEFORE
                    the sale — the dealer downloads this the moment
                    they've committed to buying the car, hands it to
                    their reconditioner, and only then answers Stage 2. */}
                {done ? (
                  <TouchableOpacity
                    testID="deal-download-recon-pdf"
                    disabled={downloadingRecon}
                    style={[styles.dealPdfBtn, styles.dealReconBtn]}
                    onPress={handleDownloadReconditioningPdf}
                  >
                    {downloadingRecon ? (
                      <ActivityIndicator size="small" color={colors.text} />
                    ) : (
                      <>
                        <Ionicons name="construct-outline" size={16} color={colors.text} />
                        <Text style={[styles.dealPdfBtnText, { color: colors.text }]}>
                          Download Reconditioning Sheet
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                ) : null}

                {/* ------ Stage 2: Sale (unlocked after Stage 1 = Yes) ------ */}
                {done ? (
                  <View style={styles.dealStage} testID="deal-stage-2">
                    <View style={styles.dealStageHeader}>
                      <View style={styles.dealStagePill}>
                        <Text style={styles.dealStagePillText}>2</Text>
                      </View>
                      <Text style={styles.dealStageTitle}>Have you sold the car?</Text>
                    </View>
                    <View style={styles.dealChoiceRow}>
                      <TouchableOpacity
                        testID="deal-sold-yes"
                        disabled={readOnly || dealSaving}
                        style={[styles.dealChoiceBtn, sold && styles.dealChoiceBtnYes]}
                        onPress={() => setDealSoldChoice("yes")}
                      >
                        <Ionicons name="checkmark-circle" size={16}
                          color={sold ? "#fff" : colors.textSecondary} />
                        <Text style={[styles.dealChoiceBtnText, sold && styles.dealChoiceBtnTextActive]}>Yes</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        testID="deal-sold-no"
                        disabled={readOnly || dealSaving}
                        style={[styles.dealChoiceBtn, dealSoldChoice === "no" && styles.dealChoiceBtnNo]}
                        onPress={() => setDealSoldChoice("no")}
                      >
                        <Ionicons name="close-circle" size={16}
                          color={dealSoldChoice === "no" ? "#fff" : colors.textSecondary} />
                        <Text style={[styles.dealChoiceBtnText, dealSoldChoice === "no" && styles.dealChoiceBtnTextActive]}>Not yet</Text>
                      </TouchableOpacity>
                    </View>
                    {sold ? (
                      <>
                        <View style={styles.dealField}>
                          <Text style={styles.dealFieldLabel}>Reconditioning costs</Text>
                          <View style={styles.dealInputWrap}>
                            <Text style={styles.dealInputPrefix}>R</Text>
                            <TextInput
                              testID="deal-recon-input"
                              style={styles.dealInput}
                              value={dealReconInput}
                              onChangeText={(t) => setDealReconInput(formatMoneyString(t))}
                              placeholder="0"
                              placeholderTextColor={colors.textDisabled}
                              keyboardType="numeric"
                              editable={!readOnly && !dealSaving}
                            />
                          </View>
                        </View>
                        <View style={styles.dealField}>
                          <Text style={styles.dealFieldLabel}>Sale price</Text>
                          <View style={styles.dealInputWrap}>
                            <Text style={styles.dealInputPrefix}>R</Text>
                            <TextInput
                              testID="deal-sale-input"
                              style={styles.dealInput}
                              value={dealSaleInput}
                              onChangeText={(t) => setDealSaleInput(formatMoneyString(t))}
                              placeholder="0"
                              placeholderTextColor={colors.textDisabled}
                              keyboardType="numeric"
                              editable={!readOnly && !dealSaving}
                            />
                          </View>
                          {deal?.sold_at ? (
                            <Text style={styles.dealMeta}>
                              Sold on {new Date(deal.sold_at).toLocaleDateString()}
                            </Text>
                          ) : null}
                        </View>
                      </>
                    ) : null}
                  </View>
                ) : null}

                {/* ------ Explicit Save button (dealer-editable path) ------
                    Always visible when the vehicle is priced and the
                    viewer is the owning dealer (not admin). Enabled
                    only when there are unsaved changes to any of the
                    outcome pills OR numeric fields. Committing here
                    also refreshes the Home-screen Deal Outcomes tile
                    on next focus. */}
                {!readOnly ? (
                  <TouchableOpacity
                    testID="deal-save-button"
                    style={[
                      styles.dealSaveBtn,
                      dealFinancialsDirty
                        ? styles.dealSaveBtnPrimary
                        : styles.dealSaveBtnSaved,
                    ]}
                    disabled={!dealFinancialsDirty || dealSaving}
                    onPress={saveDealFinancials}
                    accessibilityLabel="Save deal tracking details"
                  >
                    {dealSaving ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : dealFinancialsDirty ? (
                      <>
                        <Ionicons name="save-outline" size={16} color="#fff" />
                        <Text style={styles.dealSaveBtnText}>
                          Save Deal Tracking
                        </Text>
                      </>
                    ) : (
                      <>
                        <Ionicons
                          name="checkmark-circle"
                          size={16}
                          color={colors.textSecondary}
                        />
                        <Text
                          style={[
                            styles.dealSaveBtnText,
                            { color: colors.textSecondary },
                          ]}
                        >
                          Saved
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                ) : null}

                {/* ------ Live P&L callout + PDF ------ */}
                {profit && profit.cost_basis_zar != null ? (
                  <View
                    style={[
                      styles.dealPnl,
                      profit.profit_zar != null && profit.profit_zar >= 0
                        ? styles.dealPnlOk
                        : profit.profit_zar != null
                          ? styles.dealPnlLoss
                          : styles.dealPnlNeutral,
                    ]}
                    testID="deal-pnl"
                  >
                    <View style={styles.dealPnlRow}>
                      <Text style={styles.dealPnlLbl}>Purchase</Text>
                      <Text style={styles.dealPnlVal}>{fmtZar(profit.purchase_price_zar)}</Text>
                    </View>
                    <View style={styles.dealPnlRow}>
                      <Text style={styles.dealPnlLbl}>Recon</Text>
                      <Text style={styles.dealPnlVal}>{fmtZar(profit.recon_cost_zar)}</Text>
                    </View>
                    <View style={[styles.dealPnlRow, styles.dealPnlDivider]}>
                      <Text style={styles.dealPnlLbl}>Cost basis</Text>
                      <Text style={styles.dealPnlVal}>{fmtZar(profit.cost_basis_zar)}</Text>
                    </View>
                    <View style={styles.dealPnlRow}>
                      <Text style={styles.dealPnlLbl}>Sale</Text>
                      <Text style={styles.dealPnlVal}>{fmtZar(profit.sale_price_zar)}</Text>
                    </View>
                    <View style={[styles.dealPnlRow, styles.dealPnlProfitRow]}>
                      <Text style={styles.dealPnlProfitLbl}>
                        {profit.profit_zar != null && profit.profit_zar < 0 ? "Loss" : "Gross profit"}
                      </Text>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text
                          style={[
                            styles.dealPnlProfitVal,
                            profit.profit_zar != null && profit.profit_zar < 0 && styles.dealPnlProfitValLoss,
                          ]}
                        >
                          {fmtZar(profit.profit_zar)}
                        </Text>
                        {profit.margin_pct != null ? (
                          <Text style={styles.dealPnlMargin}>{profit.margin_pct}% margin</Text>
                        ) : null}
                      </View>
                    </View>
                    {canDownloadPdf ? (
                      <TouchableOpacity
                        testID="deal-download-pdf"
                        disabled={dealPdfDownloading}
                        style={styles.dealPdfBtn}
                        onPress={handleDownloadProfitPdf}
                      >
                        {dealPdfDownloading ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <>
                            <Ionicons name="download-outline" size={16} color="#fff" />
                            <Text style={styles.dealPdfBtnText}>Download Profit Analysis PDF</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    ) : null}
                    {/* Reconditioning Sheet button moved above Stage 2
                        so it sits inline with the pre-sale workflow. */}
                  </View>
                ) : null}
              </View>
            );
          })()
        ) : null}


      </KeyboardAwareScrollView>

      {/* Floating footer removed — pricing is now inline at the bottom
          of the scroll content. */}

      {/* Cover-placement bottom bar — visible only when the pricing
          agent is inspecting a submission via /vehicle/[id]?cover=1.
          Locked to the bottom of the viewport so the agent can enter a
          cover price while continuing to scroll the vehicle detail. */}
      {isCoverMode && coverMeta ? (
        <View style={[styles.coverPlaceBar, { bottom: kbHeight }]} testID="cover-place-bar">
          <View style={{ flex: 1 }}>
            {coverMeta.my_cover ? (
              <>
                <Text style={styles.coverPlacedTitle} testID="cover-placed-summary">
                  Cover placed · R{coverMeta.my_cover.price_zar.toLocaleString()}
                </Text>
                <Text style={styles.coverPlacedSub}>
                  Binding subject to inspection. Updates are free — the R{coverMeta.cover_cost_zar} fee was already charged on the initial cover.
                </Text>
              </>
            ) : null}
            <TextInput
              testID="cover-price-input"
              value={coverPriceInput}
              onChangeText={(t) => setCoverPriceInput(formatMoneyString(t))}
              placeholder={coverMeta.my_cover ? "Update cover (R)" : "Enter your cover (R)"}
              placeholderTextColor={colors.textDisabled}
              keyboardType="numeric"
              style={[styles.coverInput, coverMeta.my_cover && { marginTop: 6 }]}
            />
            <Text style={styles.coverBillNote}>
              {coverMeta.my_cover
                ? "Updates are free. Binding subject to inspection."
                : `R${coverMeta.cover_cost_zar} billed on submit. Binding subject to inspection.`}
            </Text>
          </View>
          <View style={styles.coverBtnRow}>
            {/* Decline — bail out and move this submission into the
                dealer's Declined silo so it never surfaces on the
                Available tab again (unless they Restore it). We only
                show the Decline button when the agent hasn't placed a
                cover yet — no point declining after having covered. */}
            {!coverMeta.my_cover ? (
              <TouchableOpacity
                testID="cover-decline-btn"
                style={[styles.coverDeclineBtn, decliningCover && { opacity: 0.6 }]}
                disabled={placingCover || decliningCover}
                onPress={async () => {
                  const proceed = await confirmAsync(
                    "Decline this cover?",
                    "You won't see this submission on your Available list again. You can restore it later from the Declined silo.",
                    "Decline",
                  );
                  if (!proceed) return;
                  setDecliningCover(true);
                  try {
                    await apiFetch(`/api/cover/submissions/${sub!.id}/decline`, {
                      method: "POST",
                    });
                    // Return to the Give Cover Available silo. Using
                    // replace so the vehicle detail is removed from
                    // the back stack — the agent shouldn't be able
                    // to swipe back into a submission they just
                    // declined.
                    router.replace("/(app)/cover?tab=available" as never);
                  } catch (e: any) {
                    Alert.alert("Decline", e?.message || "Could not decline this cover.");
                  } finally {
                    setDecliningCover(false);
                  }
                }}
              >
                {decliningCover ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Ionicons name="close-circle" size={16} color="#fff" />
                    <Text style={styles.coverDeclineBtnText}>Decline</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              testID="cover-submit-btn"
              style={[styles.coverBtn, placingCover && { opacity: 0.6 }]}
              onPress={async () => {
                const n = parseInt(coverPriceInput.replace(/[^0-9]/g, ""), 10);
                if (!n || n <= 0) {
                  Alert.alert("Enter a valid amount", "Please enter your cover price in Rand.");
                  return;
                }
                const cost = coverMeta.cover_cost_zar;
                const isUpdate = !!coverMeta.my_cover;
                const proceed = await confirmAsync(
                  isUpdate ? "Confirm cover update" : "Confirm binding cover",
                  isUpdate
                    ? `Update your binding cover to R${n.toLocaleString()}. This update is free — the R${cost} cover fee was charged on the initial placement. Cover remains binding subject to physical inspection.`
                    : `Cover of R${n.toLocaleString()}. You'll be billed R${cost} to your next invoice. Cover is binding subject to physical inspection and confirmation that all submission details are accurate.`,
                  "Confirm",
                );
                if (!proceed) return;
                setPlacingCover(true);
                try {
                  await apiFetch(`/api/submissions/${sub!.id}/covers`, {
                    method: "POST",
                    body: JSON.stringify({ price_zar: n }),
                  });
                  setCoverPriceInput("");
                  if (isUpdate) {
                    // Updates keep the user on the same page so they
                    // can adjust and re-adjust freely. Refresh the
                    // meta so the header pill shows the new amount.
                    await loadCoverMeta();
                    Alert.alert(
                      "Cover updated",
                      `Your binding cover is now R${n.toLocaleString()}. No additional charge for updates.`,
                    );
                  } else {
                    // First-time placement — bounce back to the Cover
                    // given tab of the Give Cover screen so the agent
                    // doesn't linger on the (now-priced) submission
                    // with an "Update price" bar. The Cover-given list
                    // is where the new cover naturally lives, and the
                    // agent's next action is usually to price the next
                    // vehicle in the pipeline.
                    router.replace({
                      pathname: "/(app)/cover",
                      params: { tab: "given" },
                    });
                  }
                } catch (e: any) {
                  Alert.alert("Cover", e?.message || "Could not save cover.");
                } finally {
                  setPlacingCover(false);
                }
              }}
              disabled={placingCover || decliningCover}
            >
              {placingCover ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.coverBtnText}>
                  {coverMeta.my_cover ? "Update" : "Place Cover"}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

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

      {/* Admin price / update-price modal */}
      <PriceModal
        visible={priceModal}
        sub={sub}
        priceInput={priceInput}
        notesInput={notesInput}
        changeCommentInput={changeCommentInput}
        submitting={submittingPrice}
        onPriceInputChange={setPriceInput}
        onNotesInputChange={setNotesInput}
        onChangeCommentInputChange={setChangeCommentInput}
        onClose={() => setPriceModal(false)}
        onSubmit={handleOfferPrice}
        formatZAR={formatZAR}
        formatMoneyString={formatMoneyString}
        colors={colors}
        styles={styles}
      />

      {/* Admin decline modal */}
      <DeclineModal
        visible={declineModalOpen}
        sub={sub}
        declineNote={declineNote}
        declining={declining}
        onNoteChange={setDeclineNote}
        onCancel={() => { setDeclineModalOpen(false); setDeclineNote(""); }}
        onConfirm={handleConfirmDecline}
        colors={colors}
        styles={styles}
      />

      {/* Report order confirmation modal */}
      <ConfirmReportModal
        visible={confirmReport !== null}
        report={confirmReport}
        vin={sub?.vin}
        ordering={!!orderingReportType}
        onCancel={() => setConfirmReport(null)}
        onConfirm={submitReportOrder}
        colors={colors}
        styles={styles}
      />

      {/* Report result viewer modal */}
      <ViewReportModal
        report={viewingReport}
        onClose={() => setViewingReport(null)}
        onOpenPdf={handleOpenReportPdf}
        colors={colors}
        styles={styles}
      />
    </SafeAreaView>
  );
}

