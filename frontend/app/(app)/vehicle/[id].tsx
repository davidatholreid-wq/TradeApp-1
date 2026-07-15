import { useEffect, useState } from "react";
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
import { colors, spacing, radius, fonts } from "@/src/theme";
import { apiFetch } from "@/src/api";
import { useAuth } from "@/src/context/AuthContext";
import { buildWhatsappUrl, buildDealerMessage } from "@/src/utils/whatsapp";

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
  mileage: number;
  year: number;
  factory_warranty: boolean;
  condition: number;
  accident_damage: boolean;
  colour: string;
  license_disk_data?: string;
  photos: Record<string, string>;
  status: "pending" | "priced";
  price: number | null;
  price_notes?: string | null;
  priced_at?: string | null;
  market_analysis?: MarketAnalysisPayload | null;
  market_analysis_at?: string | null;
  created_at: string;
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

const PHOTO_LABELS: Record<string, string> = {
  front: "Front",
  side_right: "Right Side",
  rear: "Rear",
  side_left: "Left Side",
  interior: "Interior",
};

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
  const [submittingPrice, setSubmittingPrice] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
        body: JSON.stringify({ price, notes: notesInput.trim() || null }),
      });
      const refreshed = await apiFetch(`/api/submissions/${id}`);
      setSub(refreshed.submission);
      setPriceModal(false);
      setPriceInput("");
      setNotesInput("");
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setSubmittingPrice(false);
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

  const conditionColor =
    sub.condition <= 3 ? colors.danger : sub.condition <= 7 ? colors.warning : colors.success;

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
          <View style={{ width: 32 }} />
        )}
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Status banner */}
        {sub.status === "priced" ? (
          <View style={styles.priceBanner} testID="price-banner">
            <View>
              <Text style={styles.priceLabel}>OFFER RECEIVED</Text>
              <Text style={styles.priceValue}>R {sub.price?.toLocaleString()}</Text>
              {sub.price_notes ? <Text style={styles.priceNotes}>{sub.price_notes}</Text> : null}
            </View>
            <Ionicons name="checkmark-circle" size={40} color={colors.success} />
          </View>
        ) : (
          <View style={styles.pendingBanner}>
            <Ionicons name="time-outline" size={20} color={colors.warning} />
            <Text style={styles.pendingText}>Awaiting price offer</Text>
          </View>
        )}

        {/* Title */}
        <View style={styles.titleBox}>
          <Text style={styles.brand}>{sub.make_name}</Text>
          <Text style={styles.model}>{sub.model_name}</Text>
          <Text style={styles.derivative}>{sub.derivative_name}</Text>
        </View>

        {/* Specs grid */}
        <View style={styles.grid}>
          <View style={styles.gridItem}>
            <Ionicons name="calendar-outline" size={16} color={colors.primary} />
            <Text style={styles.gridLabel}>Year</Text>
            <Text style={styles.gridValue}>{sub.year}</Text>
          </View>
          <View style={styles.gridItem}>
            <Ionicons name="speedometer-outline" size={16} color={colors.primary} />
            <Text style={styles.gridLabel}>Mileage</Text>
            <Text style={styles.gridValue}>{sub.mileage.toLocaleString()} km</Text>
          </View>
          <View style={styles.gridItem}>
            <Ionicons name="color-palette-outline" size={16} color={colors.primary} />
            <Text style={styles.gridLabel}>Colour</Text>
            <Text style={styles.gridValue}>{sub.colour}</Text>
          </View>
          <View style={styles.gridItem}>
            <Ionicons name="star" size={16} color={conditionColor} />
            <Text style={styles.gridLabel}>Condition</Text>
            <Text style={[styles.gridValue, { color: conditionColor }]}>{sub.condition}/10</Text>
          </View>
          <View style={styles.gridItem}>
            <Ionicons
              name={sub.factory_warranty ? "shield-checkmark" : "shield-outline"}
              size={16}
              color={sub.factory_warranty ? colors.success : colors.textSecondary}
            />
            <Text style={styles.gridLabel}>Warranty</Text>
            <Text style={styles.gridValue}>{sub.factory_warranty ? "Yes" : "No"}</Text>
          </View>
          <View style={styles.gridItem}>
            <Ionicons
              name={sub.accident_damage ? "warning" : "checkmark-circle-outline"}
              size={16}
              color={sub.accident_damage ? colors.danger : colors.success}
            />
            <Text style={styles.gridLabel}>Damage</Text>
            <Text style={[styles.gridValue, { color: sub.accident_damage ? colors.danger : colors.text }]}>
              {sub.accident_damage ? "Yes" : "None"}
            </Text>
          </View>
        </View>

        {/* Photos */}
        <Text style={styles.sectionTitle}>Photos</Text>
        <View style={styles.photoGrid}>
          {["front", "side_right", "rear", "side_left", "interior"].map((slot) => (
            <TouchableOpacity
              key={slot}
              testID={`detail-photo-${slot}`}
              style={styles.photoSlot}
              onPress={() => sub.photos[slot] && setPhotoPreview(sub.photos[slot])}
            >
              {sub.photos[slot] ? (
                <>
                  <Image source={{ uri: sub.photos[slot] }} style={styles.photoImg} />
                  <View style={styles.photoOverlay}>
                    <Text style={styles.photoLabel}>{PHOTO_LABELS[slot]}</Text>
                  </View>
                </>
              ) : (
                <Text style={styles.photoLabel}>{PHOTO_LABELS[slot]}</Text>
              )}
            </TouchableOpacity>
          ))}
        </View>

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
                  <Text style={[styles.rangeValue, { color: colors.accent }]}>
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

        {/* License disk */}
        {sub.license_disk_data ? (
          <>
            <Text style={styles.sectionTitle}>License Disk Data</Text>
            <View style={styles.diskBox}>
              <Text style={styles.diskText}>{sub.license_disk_data}</Text>
            </View>
          </>
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

      {/* Admin price button */}
      {isAdmin ? (
        <View style={styles.footer}>
          <TouchableOpacity
            testID="offer-price-button"
            style={styles.priceBtn}
            onPress={() => {
              setPriceInput(sub.price ? String(sub.price) : "");
              setNotesInput(sub.price_notes || "");
              setPriceModal(true);
            }}
          >
            <Ionicons name="pricetag" size={18} color="#fff" />
            <Text style={styles.priceBtnText}>{sub.status === "priced" ? "Update Price" : "Offer Price"}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Price modal */}
      <Modal visible={priceModal} transparent animationType="slide" onRequestClose={() => setPriceModal(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPriceModal(false)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Offer Price</Text>
              <TouchableOpacity testID="price-modal-close" onPress={() => setPriceModal(false)}>
                <Ionicons name="close" size={22} color={colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalHint}>
              {sub.year} {sub.make_name} {sub.model_name}
            </Text>
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
            <Text style={styles.label}>Notes (optional)</Text>
            <TextInput
              testID="notes-input"
              style={[styles.priceInput, { height: 80 }]}
              value={notesInput}
              onChangeText={setNotesInput}
              placeholder="e.g. Trade price offer valid 7 days"
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
                <Text style={styles.confirmBtnText}>Send Offer</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Photo preview */}
      <Modal visible={!!photoPreview} transparent onRequestClose={() => setPhotoPreview(null)}>
        <Pressable style={styles.photoPreviewOverlay} onPress={() => setPhotoPreview(null)}>
          {photoPreview ? <Image source={{ uri: photoPreview }} style={styles.photoPreviewImg} /> : null}
        </Pressable>
      </Modal>
    </SafeAreaView>
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
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: "700", fontFamily: fonts.serif, flex: 1, textAlign: "center" },
  scroll: { padding: spacing.lg, paddingBottom: 120 },
  priceBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.success + "22",
    borderWidth: 1,
    borderColor: colors.success,
    marginBottom: spacing.lg,
  },
  priceLabel: { color: colors.success, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  priceValue: { color: colors.text, fontSize: 28, fontWeight: "800", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", marginTop: 4 },
  priceNotes: { color: colors.textSecondary, fontSize: 13, marginTop: 4 },
  pendingBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.warning + "22",
    borderWidth: 1,
    borderColor: colors.warning + "55",
    marginBottom: spacing.lg,
  },
  pendingText: { color: colors.warning, fontWeight: "600" },
  titleBox: { marginBottom: spacing.md },
  brand: { color: colors.textSecondary, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1 },
  model: { color: colors.text, fontSize: 26, fontWeight: "700", fontFamily: fonts.serif, letterSpacing: 0.3 },
  derivative: { color: colors.textSecondary, fontSize: 15, marginTop: 2 },
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
  gridLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "500" },
  gridValue: { color: colors.text, fontSize: 14, fontWeight: "700" },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
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
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  photoLabel: { color: "#fff", fontSize: 12, fontWeight: "600" },
  diskBox: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md },
  diskText: { color: colors.text, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12 },
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
    borderColor: colors.primary,
    backgroundColor: colors.primary + "18",
    minWidth: 90,
    justifyContent: "center",
  },
  analysisBtnText: { color: colors.primary, fontWeight: "700", fontSize: 12, letterSpacing: 0.5 },
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
  rangeColMid: { backgroundColor: colors.accent + "18", borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.border },
  rangeLabel: { color: colors.textSecondary, fontSize: 10, letterSpacing: 1, fontWeight: "700", marginBottom: 4 },
  rangeValue: { color: colors.text, fontSize: 13, fontWeight: "700", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  tradeRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  tradeCol: { flex: 1, padding: spacing.sm, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  tradeLabel: { color: colors.textSecondary, fontSize: 10, letterSpacing: 1, fontWeight: "700", marginBottom: 4 },
  tradeValue: { color: colors.success, fontSize: 15, fontWeight: "700", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
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
    backgroundColor: colors.card + "88",
  },
  analysisEmptyText: { color: colors.textSecondary, fontSize: 12, flex: 1, lineHeight: 17 },
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
  priceBtnText: { color: "#fff", fontWeight: "700", fontSize: 15, letterSpacing: 1, textTransform: "uppercase" },
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
  modalTitle: { color: colors.text, fontSize: 22, fontWeight: "700", fontFamily: fonts.serif, letterSpacing: 0.3 },
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
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  confirmBtn: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: radius.sm,
    alignItems: "center",
  },
  confirmBtnText: { color: "#fff", fontWeight: "700", fontSize: 15, letterSpacing: 1, textTransform: "uppercase" },
  photoPreviewOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)", alignItems: "center", justifyContent: "center" },
  photoPreviewImg: { width: "100%", height: "80%", resizeMode: "contain" },
});
