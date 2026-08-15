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
import { CoverOfferTermsButton } from "@/src/components/CoverOfferTerms";
import DetailRow from "@/src/components/vehicle/DetailRow";
import HeroPill from "@/src/components/vehicle/HeroPill";
import ReportResultBody from "@/src/components/vehicle/ReportResultBody";
import MarketAnalysisCard from "@/src/components/vehicle/MarketAnalysisCard";
import VinLinkedReportsCard from "@/src/components/vehicle/VinLinkedReportsCard";
import DealTrackingCard from "@/src/components/vehicle/DealTrackingCard";
import { TransferToStockCard } from "@/src/components/vehicle/TransferToStockCard";
import { TransferToStockModal } from "@/src/components/vehicle/modals/TransferToStockModal";
import ConditionSection from "@/src/components/vehicle/ConditionSection";
import IdentityLicenseSection from "@/src/components/vehicle/IdentityLicenseSection";
import TyreEstimateCard from "@/src/components/vehicle/TyreEstimateCard";
import CoverOffersReceivedCard from "@/src/components/vehicle/CoverOffersReceivedCard";
import DealerOfferCard from "@/src/components/vehicle/DealerOfferCard";
import CoverPlacementBar from "@/src/components/vehicle/CoverPlacementBar";
import MileageIndicator from "@/src/components/vehicle/MileageIndicator";
import AssignSuppliersModal from "@/src/components/vehicle/modals/AssignSuppliersModal";
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

  // Mercedes factory-options report (mbtools.com) — offered on any
  // Mercedes-family submission (Mercedes-Benz, Mercedes-AMG, Maybach,
  // Smart). Mirrors backend `is_mb_supported_make()`; broad substring
  // match keeps us robust to typos like "Mercedes Benz" vs "Mercedes-Benz".
  const isMbSupported = useMemo(() => {
    const mk = (sub?.make_name || (sub as any)?.make || "").toString().toUpperCase();
    if (!mk) return false;
    return (
      mk.includes("MERCEDES") ||
      mk.includes("MAYBACH") ||
      mk === "AMG" ||
      mk === "SMART"
    );
  }, [sub?.make_name]);

  // Outvin multi-make VIN datacard — 30+ marques covered. Row is
  // labelled dynamically as "<Make> Factory Options" (e.g.
  // "Volkswagen Factory Options"). Mirrors backend
  // `is_outvin_supported_make()`; comparison is punctuation & case
  // insensitive so "Alfa Romeo" / "ALFA" / "Land Rover" / "LANDROVER"
  // all resolve correctly.
  const isOutvinSupported = useMemo(() => {
    const raw = (sub?.make_name || (sub as any)?.make || "").toString();
    if (!raw) return false;
    const norm = raw.toUpperCase().replace(/[\s\-_]+/g, "");
    const OUTVIN_MAKES = new Set([
      "MERCEDESBENZ","MERCEDES","MERCEDESAMG","MERCEDESMAYBACH","MAYBACH",
      "BMW","MINI","LEXUS","TOYOTA","VOLVO","OPEL","AUDI","VOLKSWAGEN","VW",
      "SKODA","RENAULT","DACIA","LANCIA","LANDROVER","RANGEROVER","JAGUAR",
      "SEAT","POLESTAR","PEUGEOT","NISSAN","CITROEN","KIA","HYUNDAI","MAZDA",
      "DS","FORD","CHRYSLER","DODGE","JEEP","FIAT","ALFA","ALFAROMEO","SMART",
      "CHEVROLET","CHEVY","GMC","CADILLAC","BUICK","HUMMER","TESLA",
    ]);
    return OUTVIN_MAKES.has(norm);
  }, [sub?.make_name]);

  // Dynamic label for the Outvin row — "<Make> Factory Options (OEM
  // Datacard)". The trailing "(OEM Datacard)" suffix disambiguates it
  // from the make-specific decoder rows on submissions where both
  // apply — e.g. a BMW carries an existing Bimmervin row whose static
  // label is ALSO "BMW Factory Options", so without the suffix a
  // dealer sees two identical-looking rows.
  const outvinReportLabel = useMemo(() => {
    const raw = (sub?.make_name || (sub as any)?.make || "").toString().trim();
    if (!raw) return "Factory Options (OEM Datacard)";
    return `${raw} Factory Options (OEM Datacard)`;
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
  // Assign-Suppliers modal (managerial-only). The modal loads the
  // dealership's supplier catalog itself; we just gate visibility here.
  const [assignSuppliersOpen, setAssignSuppliersOpen] = useState(false);
  // Transfer-to-Stock modal + un-transfer loading state — the Aug 2026
  // stock rework hangs off these two.  The Deal Tracking legacy state
  // (dealDoneChoice / dealSoldChoice / dealPurchaseInput / …) is kept
  // in the file so we don't churn the numerous prop drills below, but
  // it is no longer rendered — see the TransferToStockCard block at
  // the bottom of the scroll where DealTrackingCard used to live.
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [untransferring, setUntransferring] = useState(false);
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
    // Derived server-side (`_derive_ownership_status`). Values:
    //   "populated" — at least one ownership field has a real value.
    //   "pending"   — every ownership field is "No Record Found" (Kredo's
    //                 downstream feed hasn't backfilled yet).
    //   "unknown"   — couldn't locate an ownership block (schema drift).
    ownership_status?: "populated" | "pending" | "unknown" | null;
    last_callback_at?: string | null;
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
      // On native we hand the URL DIRECTLY to expo-web-browser so iOS
      // opens the PDF inline in Safari View Controller (full scroll +
      // zoom + built-in share) instead of the share sheet. To keep the
      // endpoint authenticated we pass the JWT as `?access_token=` — the
      // backend's `get_user_flexible` dependency accepts either the
      // Bearer header (used by fetch()) or this query-string token.
      //
      // IMPORTANT: tokens are stored via `storage.secureSet` (Keychain /
      // SecureStore); reading with `getItem` (AsyncStorage) returns null
      // and the request goes out unauthenticated → 401.
      const token = await storage.secureGet<string>(TOKEN_KEY, "");
      const base = process.env.EXPO_PUBLIC_BACKEND_URL || "";
      // Cache-buster: the endpoint's PDF payload has churned twice in
      // Aug 2026 (compact local render → full Kredo 5-page → merged
      // with valuation). Fresh URL every open keeps the browser / OS
      // PDF viewer from serving a stale blob.
      const ts = Date.now();

      if (Platform.OS === "web") {
        // Web: fetch as blob (with header) → object URL → open new tab.
        // We can't rely on ?access_token because on web the browser
        // will happily follow a redirect and expose the token in
        // history/logs; the header + blob route is safer.
        const res = await fetch(`${base}/api/kredo/cartrust/pdf/${sub.id}?t=${ts}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: "no-store" as any,
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        await WebBrowser.openBrowserAsync(objUrl);
        setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
      } else {
        // Native: use the authenticated https URL directly — Safari
        // View Controller / Chrome Custom Tab render PDFs inline.
        const authedUrl = `${base}/api/kredo/cartrust/pdf/${sub.id}?t=${ts}${
          token ? `&access_token=${encodeURIComponent(token)}` : ""
        }`;
        await WebBrowser.openBrowserAsync(authedUrl, {
          // Prefer a modal-style in-app viewer with a Done button.
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
          controlsColor: "#ffffff",
          toolbarColor: "#000000",
        });
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
    // Mercedes factory options — live mbtools.com lookup, offered on
    // any Mercedes-family vehicle (Mercedes-Benz, AMG, Maybach, Smart).
    mb_options: { name: "Mercedes Factory Options", cost_zar: 20 },
    // Outvin multi-make datacard — R20/lookup, covers 30+ manufacturers.
    // The display name is REWRITTEN per-submission by VinLinkedReportsCard
    // to the actual make name (e.g. "Volkswagen Factory Options") — the
    // generic label below only shows up for orders on submissions where
    // the make couldn't be resolved.
    outvin_spec: { name: "Factory Options", cost_zar: 20 },
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
          setSub(fresh.submission ?? fresh);
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
      // 404 means the vendor reported "no data for this VIN" (not our
      // fault, not a system error, not billed). Show a soft "no data
      // available" info alert instead of a red "Order failed" — this is
      // very common for grey-imports and brand-new models.
      if (e?.status === 404) {
        Alert.alert(
          "No factory data available",
          e?.message ||
            "The vehicle spec provider has no data on file for this VIN yet. " +
            "Not all models are in their dataset — please try again in a few weeks. " +
            "You have NOT been charged for this attempt.",
        );
      } else {
        Alert.alert("Order failed", e.message || "Could not place the report order");
      }
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

  // -------------------------------------------------------------------------
  // Transfer to Stock — creates a stock_items row from this submission's
  // vehicle info + the dealer-supplied stock_number & target price.
  // Reloads the submission so the "IN STOCK" badge appears immediately.
  // -------------------------------------------------------------------------
  const refreshSubmission = useCallback(async () => {
    if (!id) return;
    try {
      const fresh = await apiFetch(`/api/submissions/${id}`);
      // The submissions endpoint returns { submission: {...}, deal_profit, … }
      setSub((fresh as any)?.submission ?? (fresh as any));
    } catch {
      /* non-fatal — a manual pull-to-refresh will catch it */
    }
  }, [id]);

  const handleTransferToStock = useCallback(
    async (payload: { stock_number: string; target_sell_price_zar: number }) => {
      if (!sub) return;
      try {
        await apiFetch(`/api/submissions/${sub.id}/transfer-to-stock`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setTransferModalOpen(false);
        await refreshSubmission();
      } catch (e: any) {
        Alert.alert("Transfer failed", e?.message || "Please try again.");
      }
    },
    [sub, refreshSubmission],
  );

  const handleUntransferFromStock = useCallback(async () => {
    if (!sub) return;
    const proceed = await confirmAsync(
      "Remove from Stock?",
      "This will remove the vehicle from your stock list and unlock the My Offer price on this submission so you can revise it. Sold vehicles cannot be un-transferred.",
      "Remove",
    );
    if (!proceed) return;
    setUntransferring(true);
    try {
      await apiFetch(`/api/submissions/${sub.id}/untransfer-from-stock`, {
        method: "POST",
      });
      await refreshSubmission();
    } catch (e: any) {
      Alert.alert("Couldn't un-transfer", e?.message || "Please try again.");
    } finally {
      setUntransferring(false);
    }
  }, [sub, refreshSubmission]);

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
                    // IMPORTANT: auth tokens are written via
                    // `storage.secureSet` (Keychain / SecureStore).
                    // Reading with `getItem` (AsyncStorage) returns
                    // null and the request goes out unauthenticated →
                    // the backend rejects it with 401. Always use
                    // `secureGet` for TOKEN_KEY.
                    const token = await storage.secureGet<string>(TOKEN_KEY, "");
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
                      // iOS `WebBrowser.openBrowserAsync` refuses
                      // file:// URLs ("The provided URL is not valid").
                      // Route through expo-sharing for an inline PDF
                      // preview + native save/print/mail options.
                      const canShare = await Sharing.isAvailableAsync();
                      if (canShare) {
                        await Sharing.shareAsync(path, {
                          mimeType: "application/pdf",
                          dialogTitle: "Archived Valuation PDF",
                          UTI: "com.adobe.pdf",
                        });
                      } else {
                        await WebBrowser.openBrowserAsync(path);
                      }
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
            // Otherwise prefer the browser/native back-stack if we have
            // history to walk. When there IS no history (deep-link,
            // fresh reload, or a router.replace(...) chain that lost the
            // stack) fall back to the dealer's submissions inbox — the
            // route dealers usually arrive from via the "My Evaluations"
            // home tile. Going home was disorienting.
            // @ts-ignore  — canGoBack is present at runtime on expo-router v3+
            const canGo = typeof router.canGoBack === "function" ? router.canGoBack() : true;
            if (canGo) {
              router.back();
            } else {
              router.replace("/(app)/submissions" as never);
            }
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

        {/* Mileage indicator — km-per-year band (very low → very high) computed
            from the model year (Jan 1) to the submission date. */}
        {sub.year && sub.mileage != null ? (
          <MileageIndicator
            year={sub.year}
            mileageKm={sub.mileage}
            submittedAt={sub.created_at}
            colors={colors}
          />
        ) : null}

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
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.priceLabel}>FOURBUY OFFER</Text>
                <Text style={styles.priceValue}>{formatZAR(sub.price)}</Text>
                {sub.price_notes ? <Text style={styles.priceNotes}>{sub.price_notes}</Text> : null}
                {/* Terms & Conditions of Offer — attached exclusively to
                    the Fourbuy Offer (admin → dealer purchase offer).
                    Dealer-to-dealer covers are governed by each dealer's
                    own terms and deliberately don't carry this button. */}
                <View style={{ marginTop: 8, alignItems: "flex-start" }}>
                  <CoverOfferTermsButton label="Terms & Conditions of Offer" compact />
                </View>
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

        {/* Cover Offers Received — see CoverOffersReceivedCard */}
        <CoverOffersReceivedCard
          sub={sub}
          coverOffers={coverOffers}
          isCoverMode={isCoverMode}
          open={coverOffersOpen}
          onToggle={() => setCoverOffersOpen((v) => !v)}
          colors={colors}
          styles={styles}
        />

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

        {/* Identity + License disk — see IdentityLicenseSection */}
        <IdentityLicenseSection sub={sub} colors={colors} styles={styles} />

        {/* Condition breakdown + Overall condition hero + Subject-to-View — see ConditionSection */}
        <ConditionSection
          sub={sub}
          averageRating={averageRating}
          onOpenRatingGuide={() => setConditionInfoOpen(true)}
          colors={colors}
          styles={styles}
        />

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

        {/* AI Market Analysis — collapsed by default. See MarketAnalysisCard. */}
        <MarketAnalysisCard
          analysis={sub.market_analysis}
          open={isOpen("ai")}
          onToggle={() => toggleSection("ai")}
          analysing={analysing}
          onAnalyse={handleMarketAnalysis}
          colors={colors}
          styles={styles}
        />

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

        {/* Tyre Replacement Estimate — admin-only, see TyreEstimateCard */}
        {isAdmin ? (
          <TyreEstimateCard
            tyreEstimate={sub.tyre_estimate}
            estimating={estimatingTyres}
            onEstimate={handleTyreEstimate}
            colors={colors}
            styles={styles}
          />
        ) : null}

        {/* VIN-Linked Reports — see VinLinkedReportsCard for full markup. */}
        <VinLinkedReportsCard
          sub={sub}
          isAdmin={isAdmin}
          isCoverMode={isCoverMode}
          isBimmerSupported={isBimmerSupported}
          isMbSupported={isMbSupported}
          isOutvinSupported={isOutvinSupported}
          outvinReportLabel={outvinReportLabel}
          isLandroverSupported={isLandroverSupported}
          reportCatalog={REPORT_CATALOG}
          orderedReportTypes={orderedReportTypes}
          orderingReportType={orderingReportType}
          cartrust={cartrust}
          cartrustLoading={cartrustLoading}
          open={isOpen("reports")}
          onToggle={() => toggleSection("reports")}
          onViewReport={(order) => setViewingReport(order)}
          onConfirmOrder={(choice) => setConfirmReport(choice as any)}
          onOpenCartrust={openCartrust}
          onScanLicenseDisk={() => router.push({
            pathname: "/(app)/scan",
            params: { returnPath: "attachDisk", submissionId: sub.id },
          } as any)}
          colors={colors}
          styles={styles}
        />

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

        {/* ==================== DEALER OFFER CARD ==================== see DealerOfferCard */}
        {!isCoverMode && (isAdmin || isOwningDealer) ? (
          (() => {
            const deal = (sub as any).deal as DealInfo | null | undefined;
            // My Offer is locked once the submission has been
            // transferred to stock — the dealer must un-transfer first
            // (which un-locks it) if they want to change their offer.
            const inStock = !!((sub as any)?.stock_item_id);
            const canEditOffer =
              !isAdmin && isOwningDealer && !!((user as any)?.is_pricing_agent) && !inStock;
            return (
              <DealerOfferCard
                deal={deal}
                isAdmin={isAdmin}
                canEditOffer={canEditOffer}
                dealOfferInput={dealOfferInput}
                onOfferInputChange={setDealOfferInput}
                dealSaving={dealSaving}
                onSaveOffer={(parsed) => patchDeal({ dealer_offer_zar: parsed })}
                parseMoneyInput={parseMoneyInput}
                formatMoneyString={formatMoneyString}
                fmtZar={fmtZar}
                dealerOfferHistoryOpen={dealerOfferHistoryOpen}
                onToggleHistory={() => setDealerOfferHistoryOpen((v) => !v)}
                colors={colors}
                styles={styles}
              />
            );
          })()
        ) : null}

        {/* ==================== TRANSFER TO STOCK ====================
            Replaces the old Deal Tracking flow (Aug 2026 rework). One
            button — "Transfer to Stock" — captures a stock number +
            target sell price and drops the vehicle into the standalone
            stock_items collection.  Once transferred, the card shows
            the STK-#### badge, the recon PDF download, supplier
            assignment pill, and an un-transfer button.  Visible only
            to users on the OWNING dealership + admins.  Hidden in
            cover-mode.  Requires a fully-valued submission (subject-
            to-view vehicles cannot be transferred). */}
        {!isCoverMode && sub.status !== "pending" && (isAdmin || isOwningDealer) ? (
          (() => {
            const stockItemId = (sub as any)?.stock_item_id || null;
            const stockNumber = (sub as any)?.stock_number || null;
            const transferredAt = (sub as any)?.transferred_to_stock_at || null;
            const canTransfer = isAdmin || (isOwningDealer && !!((user as any)?.is_pricing_agent));
            const isFullyValued = !!(sub as any)?.priced_at;
            // Normalise the deal.done tri-state so the card can drive
            // the outcome chips: true → Deal Done, false → No Deal,
            // undefined/null → Pending.
            const rawDone = (sub as any)?.deal?.done;
            const dealDoneVal: boolean | null =
              rawDone === true ? true : rawDone === false ? false : null;
            return (
              <TransferToStockCard
                stockItemId={stockItemId}
                stockNumber={stockNumber}
                transferredAt={transferredAt}
                isFullyValued={isFullyValued}
                dealDone={dealDoneVal}
                updatingDealOutcome={dealSaving}
                onSetDealOutcome={(val) => patchDeal({ done: val })}
                canTransfer={canTransfer}
                onOpenTransferModal={() => setTransferModalOpen(true)}
                onUntransfer={handleUntransferFromStock}
                untransferring={untransferring}
                downloadingRecon={downloadingRecon}
                onDownloadReconPdf={handleDownloadReconditioningPdf}
                supplierAssignmentSummary={{
                  total: (sub as any)?.reconditioning_items?.length || 0,
                  assigned: ((sub as any)?.reconditioning_items || []).filter(
                    (r: any) => r?.supplier?.id,
                  ).length,
                }}
                onAssignSuppliers={canTransfer ? () => setAssignSuppliersOpen(true) : undefined}
                colors={colors}
              />
            );
          })()
        ) : null}


      </KeyboardAwareScrollView>

      {/* Floating footer removed — pricing is now inline at the bottom
          of the scroll content. */}

      {/* Cover-placement bottom bar — see CoverPlacementBar (visible only in cover mode). */}
      {isCoverMode && coverMeta ? (
        <CoverPlacementBar
          coverMeta={coverMeta}
          coverPriceInput={coverPriceInput}
          onCoverPriceChange={setCoverPriceInput}
          formatMoneyString={formatMoneyString}
          placingCover={placingCover}
          decliningCover={decliningCover}
          onDecline={async () => {
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
              router.replace("/(app)/cover?tab=available" as never);
            } catch (e: any) {
              Alert.alert("Decline", e?.message || "Could not decline this cover.");
            } finally {
              setDecliningCover(false);
            }
          }}
          onSubmitCover={async () => {
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
                await loadCoverMeta();
                Alert.alert(
                  "Cover updated",
                  `Your binding cover is now R${n.toLocaleString()}. No additional charge for updates.`,
                );
              } else {
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
          kbHeight={kbHeight}
          colors={colors}
          styles={styles}
        />
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
        visible={declineModal}
        sub={sub}
        declineNote={declineNote}
        declining={declining}
        onNoteChange={setDeclineNote}
        onCancel={() => { setDeclineModal(false); setDeclineNote(""); }}
        onConfirm={handleDeclineOffer}
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

      {/* Assign Suppliers modal — managerial users assigning suppliers
          to reconditioning line items. Refreshes `sub` on any change so
          the pill button's assigned/total counter updates instantly and
          the recon PDF picks up the new supplier snapshot. */}
      <AssignSuppliersModal
        visible={assignSuppliersOpen}
        onClose={() => setAssignSuppliersOpen(false)}
        submissionId={sub?.id || ""}
        reconItems={((sub as any)?.reconditioning_items || []).map(
          (r: any, i: number) => ({
            index: i,
            category: r?.category,
            label: r?.label,
            amount_zar: r?.amount_zar,
            supplier: r?.supplier || null,
          }),
        )}
        colors={colors}
        onAssignmentsChanged={async () => {
          try {
            const fresh = await apiFetch(`/api/submissions/${sub!.id}`);
            setSub(fresh.submission ?? fresh);
          } catch {
            /* non-fatal */
          }
        }}
      />

      {/* Transfer-to-Stock modal — 2 fields (stock number + target
          selling price). On success we refresh the submission so the
          "IN STOCK" badge + un-transfer button appear immediately. */}
      <TransferToStockModal
        visible={transferModalOpen}
        onClose={() => setTransferModalOpen(false)}
        onSubmit={handleTransferToStock}
        vehicleTitle={
          [sub?.year, (sub as any)?.make_name, (sub as any)?.model_name]
            .filter(Boolean)
            .join(" ") || "Vehicle"
        }
        vehicleSubtitle={
          (sub as any)?.derivative_name ||
          ((sub as any)?.reference ? String((sub as any).reference) : null)
        }
        suggestedTargetZar={
          ((sub as any)?.price?.offer_to_dealer_zar as number | undefined) ||
          ((sub as any)?.deal?.dealer_offer_zar as number | undefined) ||
          null
        }
        colors={colors}
      />
    </SafeAreaView>
  );
}

