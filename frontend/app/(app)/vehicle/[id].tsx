import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Image,
  TouchableOpacity,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { colors, spacing, radius, fonts } from "@/src/theme";
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

type ReconItem = { label: string; amount_zar: number };

type Submission = {
  id: string;
  reference?: string;
  dealer_id: string;
  dealer_name?: string;
  dealer_first_name?: string;
  dealer_phone?: string;
  dealer_email?: string;
  company_name?: string;
  make_name: string;
  model_name: string;
  derivative_name: string;
  fuel_type?: string;
  year_of_production?: number;
  transmission?: string;
  year_registered?: number;
  mileage: number;
  year: number;
  factory_warranty?: boolean;
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
  rim_size?: number | null;
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
  type: "lightstone_verification" | "lightstone_repair" | "car_vertical";
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

export default function VehicleDetail() {
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
  const [declineModal, setDeclineModal] = useState(false);
  const [declineNote, setDeclineNote] = useState("");
  const [declining, setDeclining] = useState(false);

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

  const carouselPhotos: CarouselPhoto[] = useMemo(() => {
    if (!sub) return [];
    return PHOTO_ORDER.map((p) => ({
      uri: resolvePhoto(sub.photos || {}, p.key, p.fallback),
      label: p.label,
    })).filter((p) => !!p.uri);
  }, [sub]);

  const averageRating = useMemo(() => {
    if (!sub) return null;
    // New submissions use the four weighted pillars. Weightings:
    //   Mechanical 30% · Cosmetic 25% · Interior 25% · History 20%.
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
    ReportOrder["type"],
    { name: string; cost_zar: number }
  > = {
    lightstone_verification: { name: "Lightstone Vehicle Verification Report", cost_zar: 100 },
    lightstone_repair: { name: "Lightstone Vehicle Repair History Report", cost_zar: 50 },
    car_vertical: { name: "Car Vertical Report", cost_zar: 200 },
  };

  const orderedReportTypes = useMemo(
    () => new Set((sub?.report_orders || []).map((r) => r.type)),
    [sub?.report_orders]
  );

  const submitReportOrder = async () => {
    if (!sub || !confirmReport) return;
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

  const handleDelete = () => {
    if (!sub) return;
    Alert.alert(
      "Delete Vehicle",
      `Permanently remove ${sub.reference ?? "this submission"}? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              await apiFetch(`/api/admin/submissions/${id}`, { method: "DELETE" });
              router.back();
            } catch (e: any) {
              Alert.alert("Error", e.message);
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
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
          <BrandLogo size="xs" />
        )}
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Reference badge */}
        {sub.reference ? (
          <View style={styles.refBadge}>
            <Text style={styles.refBadgeLabel}>REFERENCE</Text>
            <Text style={styles.refBadgeValue}>{sub.reference}</Text>
          </View>
        ) : null}

        {/* Title */}
        <View style={styles.titleBox}>
          <Text style={styles.brand}>{sub.make_name}</Text>
          <Text style={styles.model}>{sub.model_name}</Text>
          <Text style={styles.derivative}>{sub.derivative_name}</Text>
        </View>

        {/* Vehicle Details — vertical spec list, easy to scan top-to-bottom */}
        <Text style={styles.sectionTitle}>Vehicle Details</Text>
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
            label="Rim Size"
            value={sub.rim_size ? `${sub.rim_size}″` : "—"}
          />
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

        {/* Condition breakdown — 4 pillars for new submissions, legacy 3 fallback. */}
        <Text style={styles.sectionTitle}>Condition</Text>
        <View style={styles.detailsList}>
          {typeof sub.mechanical_condition === "number" ? (
            <>
              <DetailRow label="Mechanical Health" value={`${sub.mechanical_condition} / 10`} />
              <DetailRow label="Cosmetic Appearance" value={`${sub.cosmetic_condition} / 10`} />
              <DetailRow label="Interior Condition" value={`${sub.interior_condition} / 10`} />
              <DetailRow label="History / Maintenance" value={`${sub.history_condition} / 10`} />
            </>
          ) : (
            <>
              <DetailRow label="Exterior" value={sub.exterior_condition ? `${sub.exterior_condition} / 10` : "—"} />
              <DetailRow label="Interior" value={sub.interior_condition ? `${sub.interior_condition} / 10` : "—"} />
              <DetailRow label="Tyres" value={sub.tyre_condition ? `${sub.tyre_condition} / 10` : "—"} />
            </>
          )}
          <DetailRow label="Windscreen" value={sub.windscreen_condition ?? "—"} />
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
                  <HeroPill label="HIST" value={sub.history_condition} />
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

        {/* Reconditioning */}
        {sub.reconditioning_items && sub.reconditioning_items.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Reconditioning Estimate</Text>
            <View style={styles.detailsList}>
              {sub.reconditioning_items.map((r, i) => (
                <View key={i} style={styles.reconRow}>
                  <Text style={styles.reconLabel}>{r.label}</Text>
                  <Text style={styles.reconAmount}>R {r.amount_zar.toLocaleString()}</Text>
                </View>
              ))}
              <View style={styles.reconTotalRow}>
                <Text style={styles.reconTotalLabel}>TOTAL</Text>
                <Text style={styles.reconTotalValue}>
                  R {(sub.reconditioning_total_zar ?? sub.reconditioning_items.reduce((s, x) => s + (x.amount_zar || 0), 0)).toLocaleString()}
                </Text>
              </View>
            </View>
          </>
        ) : null}

        {/* Service history */}
        {sub.service_history ? (
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
                  {sub.rim_size ? (
                    <Text style={styles.tyreRimText}>Rim: {sub.rim_size}″</Text>
                  ) : null}
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

                {(["lightstone_verification", "lightstone_repair", "car_vertical"] as ReportOrder["type"][])
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
                              <Ionicons name="eye-outline" size={16} color="#000" />
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
                              <ActivityIndicator color="#000" size="small" />
                            ) : (
                              <Text style={styles.orderBtnText}>Order</Text>
                            )}
                          </TouchableOpacity>
                        )}
                      </View>
                    );
                  })}
              </>
            ) : null}
          </View>
        ) : null}

        {/* Dealer info for admin */}
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
      </ScrollView>

      {/* Admin action footer — Price + Cannot Offer */}
      {isAdmin ? (
        <View style={styles.footer}>
          <TouchableOpacity
            testID="offer-price-button"
            style={[styles.priceBtn, { flex: 1 }]}
            onPress={() => {
              setPriceInput(sub.price ? String(sub.price) : "");
              setNotesInput(sub.price_notes || "");
              setChangeCommentInput("");
              setPriceModal(true);
            }}
          >
            <Ionicons name="pricetag" size={18} color="#000" />
            <Text style={styles.priceBtnText}>
              {sub.status === "priced" ? "Update Price" : "Offer Price"}
            </Text>
          </TouchableOpacity>

          {/* Only show "Cannot Offer" while the submission has NOT been priced.
              Once priced, admins should update or void the offer via the
              existing flow rather than declining. */}
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
      ) : null}

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
                  {sub.status === "priced" ? "Update Offer" : "Send Offer"}
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
                  <ActivityIndicator color="#000" />
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
                  <ActivityIndicator color="#000" />
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
                <Ionicons name="document-text-outline" size={18} color="#000" />
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

const styles = StyleSheet.create({
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
  orderBtnText: { color: "#000", fontWeight: "800", letterSpacing: 1, fontSize: 12, textTransform: "uppercase" },

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
  reportModalConfirmText: { color: "#000", fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },


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

  reconRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
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
  tyreRimText: { color: colors.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
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
  priceBtnText: { color: "#000", fontWeight: "800", fontSize: 15, letterSpacing: 0.4 },
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
  confirmBtnText: { color: "#000", fontWeight: "800", fontSize: 15, letterSpacing: 0.4 },

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
    color: "#000",
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
    color: "#000",
    fontWeight: "800",
    letterSpacing: 1,
    marginLeft: 6,
    textTransform: "uppercase",
    fontSize: 13,
  },
});
