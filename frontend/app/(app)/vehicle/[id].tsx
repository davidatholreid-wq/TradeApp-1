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
import { colors, spacing, radius } from "@/src/theme";
import { apiFetch } from "@/src/api";
import { useAuth } from "@/src/context/AuthContext";

type Submission = {
  id: string;
  dealer_id: string;
  dealer_name?: string;
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
  created_at: string;
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
          {sub.year} {sub.make_name}
        </Text>
        <View style={{ width: 32 }} />
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
  backBtn: { padding: 4 },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center" },
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
  model: { color: colors.text, fontSize: 26, fontWeight: "800" },
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
  dealerBox: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md },
  dealerName: { color: colors.text, fontSize: 15, fontWeight: "700" },
  dealerCompany: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  dealerEmail: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
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
    borderRadius: radius.pill,
    paddingVertical: 14,
  },
  priceBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
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
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: "800" },
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
    borderRadius: radius.pill,
    alignItems: "center",
  },
  confirmBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  photoPreviewOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.95)", alignItems: "center", justifyContent: "center" },
  photoPreviewImg: { width: "100%", height: "80%", resizeMode: "contain" },
});
