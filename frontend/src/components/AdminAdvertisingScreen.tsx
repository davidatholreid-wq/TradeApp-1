// -----------------------------------------------------------------------------
// AdminAdvertisingScreen — admin module for managing the 10 Home advertising
// slots. Admin picks a slot, uploads an image, selects a registered dealership
// from a dropdown, sets duration in months, and saves. Billing is R1000 per
// month per slot, routed through the standard billing ledger.
// -----------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  ActivityIndicator,
  Platform,
  Modal,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
type AdSlot = {
  slot_number: number;
  dealership_id?: string | null;
  dealership_name?: string | null;
  duration_months?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
  cost_zar?: number | null;
  active: boolean;
  has_image: boolean;
  image_base64?: string | null;
  updated_at?: string | null;
};

type AdsSpec = {
  aspect_ratio: string;
  recommended_width: number;
  recommended_height: number;
  min_width: number;
  min_height: number;
  max_bytes: number;
  formats: string[];
};

type Dealership = { id: string; name: string; active?: boolean };

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const fmtZAR = (n?: number | null) =>
  n === null || n === undefined
    ? "—"
    : "R" + Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtDate = (iso?: string | null) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
};

const bytesToMB = (b: number) => (b / (1024 * 1024)).toFixed(1);

// -----------------------------------------------------------------------------
// Screen
// -----------------------------------------------------------------------------
export default function AdminAdvertisingScreen() {
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const isWide = width >= 900;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<AdSlot[]>([]);
  const [spec, setSpec] = useState<AdsSpec | null>(null);
  const [monthlyFee, setMonthlyFee] = useState(1000);
  const [dealerships, setDealerships] = useState<Dealership[]>([]);
  const [editing, setEditing] = useState<AdSlot | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [adsRes, dsRes] = await Promise.all([
        apiFetch("/api/admin/ads"),
        apiFetch("/api/admin/dealerships"),
      ]);
      setSlots(adsRes.slots || []);
      setSpec(adsRes.spec || null);
      setMonthlyFee(Number(adsRes.monthly_fee_zar) || 1000);
      const list: Dealership[] = (dsRes.dealerships || []).map((d: any) => ({
        id: d.id, name: d.name, active: d.active !== false,
      }));
      list.sort((a, b) => a.name.localeCompare(b.name));
      setDealerships(list);
    } catch (e: any) {
      setError(e?.message || "Failed to load advertising slots");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // -------- open editor -------------------------------------------------------
  const openEditor = async (slotNumber: number) => {
    // Fetch full slot detail (including image) before opening the modal.
    try {
      const r = await apiFetch(`/api/admin/ads/${slotNumber}`);
      setEditing(r.slot);
    } catch (e: any) {
      setError(e?.message || "Failed to open slot");
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>ADMIN COCKPIT</Text>
            <Text style={styles.title}>Home Advertising</Text>
            <Text style={styles.sub}>
              10 fixed slots on the dealer/admin Home page. Assign a dealer and duration —
              billing runs through the standard ledger at{" "}
              <Text style={styles.subStrong}>{fmtZAR(monthlyFee)}</Text> per slot per month.
            </Text>
          </View>
          <TouchableOpacity style={styles.refreshBtn} onPress={load}>
            <Ionicons name="refresh" size={16} color={colors.text} />
            <Text style={styles.refreshTxt}>Refresh</Text>
          </TouchableOpacity>
        </View>

        {/* Image spec card — visible to admin so they know what to upload */}
        {spec ? (
          <View style={styles.specCard}>
            <View style={styles.specRow}>
              <Ionicons name="information-circle" size={18} color={colors.primary} />
              <Text style={styles.specTitle}>Image requirements</Text>
            </View>
            <View style={styles.specGrid}>
              <SpecItem label="Aspect ratio" value={spec.aspect_ratio} />
              <SpecItem label="Recommended" value={`${spec.recommended_width} × ${spec.recommended_height} px`} />
              <SpecItem label="Minimum" value={`${spec.min_width} × ${spec.min_height} px`} />
              <SpecItem label="Max file size" value={`${bytesToMB(spec.max_bytes)} MB`} />
              <SpecItem label="Formats" value={spec.formats.join(", ")} />
              <SpecItem label="Safe zone" value="Centre — edges may crop" />
            </View>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorRow}>
            <Ionicons name="warning" size={16} color={colors.danger} />
            <Text style={styles.errorTxt}>{error}</Text>
          </View>
        ) : null}

        {/* Slot grid */}
        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : (
          <View style={[styles.grid, isWide && styles.gridWide]}>
            {slots.map((s) => (
              <SlotCard
                key={s.slot_number}
                slot={s}
                styles={styles}
                colors={colors}
                onPress={() => openEditor(s.slot_number)}
              />
            ))}
          </View>
        )}
      </ScrollView>

      {editing ? (
        <SlotEditorModal
          slot={editing}
          dealerships={dealerships}
          spec={spec}
          monthlyFee={monthlyFee}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      ) : null}
    </View>
  );
}

// -----------------------------------------------------------------------------
// SpecItem
// -----------------------------------------------------------------------------
function SpecItem({ label, value }: { label: string; value: string }) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.specItem}>
      <Text style={styles.specLbl}>{label}</Text>
      <Text style={styles.specVal}>{value}</Text>
    </View>
  );
}

// -----------------------------------------------------------------------------
// SlotCard — one of the 10 tiles in the admin grid.
// -----------------------------------------------------------------------------
function SlotCard({
  slot, styles, colors, onPress,
}: {
  slot: AdSlot; styles: ReturnType<typeof makeStyles>; colors: Palette; onPress: () => void;
}) {
  const status = !slot.has_image
    ? { text: "EMPTY", color: colors.textSecondary, bg: "rgba(255,255,255,0.05)" }
    : slot.active
      ? { text: "ACTIVE", color: colors.success, bg: "rgba(46,204,113,0.15)" }
      : { text: "EXPIRED", color: colors.warning, bg: "rgba(255,193,7,0.15)" };

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Slot ${slot.slot_number}. ${status.text}. Tap to edit.`}
    >
      <View style={styles.cardImgWrap}>
        {slot.has_image && slot.image_base64 ? (
          <Image source={{ uri: slot.image_base64 }} style={styles.cardImg} resizeMode="cover" />
        ) : (
          <View style={styles.cardImgEmpty}>
            <Ionicons name="image-outline" size={30} color={colors.textSecondary} />
            <Text style={styles.cardImgEmptyTxt}>No image</Text>
          </View>
        )}
        <View style={[styles.statusPill, { backgroundColor: status.bg }]}>
          <Text style={[styles.statusPillTxt, { color: status.color }]}>{status.text}</Text>
        </View>
        <View style={styles.slotNumChip}>
          <Text style={styles.slotNumChipTxt}>SLOT {slot.slot_number}</Text>
        </View>
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardDealer} numberOfLines={1}>
          {slot.dealership_name || "— No advertiser —"}
        </Text>
        <View style={styles.cardMetaRow}>
          <Ionicons name="calendar-outline" size={12} color={colors.textSecondary} />
          <Text style={styles.cardMeta} numberOfLines={1}>
            {slot.has_image ? `${fmtDate(slot.starts_at)} → ${fmtDate(slot.ends_at)}` : "Not scheduled"}
          </Text>
        </View>
        <View style={styles.cardMetaRow}>
          <Ionicons name="cash-outline" size={12} color={colors.textSecondary} />
          <Text style={styles.cardMeta} numberOfLines={1}>
            {slot.duration_months
              ? `${slot.duration_months} mo · ${fmtZAR(slot.cost_zar)}`
              : "—"}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

// -----------------------------------------------------------------------------
// SlotEditorModal
// -----------------------------------------------------------------------------
function SlotEditorModal({
  slot, dealerships, spec, monthlyFee, onClose, onSaved,
}: {
  slot: AdSlot;
  dealerships: Dealership[];
  spec: AdsSpec | null;
  monthlyFee: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  const isWide = width >= 720;

  const [imageDataUrl, setImageDataUrl] = useState<string | null>(slot.image_base64 || null);
  const [imageBytes, setImageBytes] = useState<number>(0);
  const [dealershipId, setDealershipId] = useState<string>(slot.dealership_id || "");
  const [months, setMonths] = useState<number>(1);
  const [showDealerDropdown, setShowDealerDropdown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingImage, setPickingImage] = useState(false);

  const isExtension =
    slot.has_image && slot.active && slot.dealership_id && slot.dealership_id === dealershipId;

  const cost = months * monthlyFee;

  const selectedDealer = dealerships.find((d) => d.id === dealershipId);

  // -------- image picker (web + native) --------------------------------------
  const pickImage = useCallback(async () => {
    setError(null); setPickingImage(true);
    try {
      if (Platform.OS === "web") {
        // Web: use a hidden <input type="file"> so we can hard-limit accepted formats.
        const input: any = (globalThis as any).document.createElement("input");
        input.type = "file";
        input.accept = "image/jpeg,image/png,image/webp";
        const file: File | null = await new Promise((resolve) => {
          input.onchange = () => resolve(input.files?.[0] || null);
          input.click();
        });
        if (!file) return;
        if (spec && file.size > spec.max_bytes) {
          setError(`File is ${bytesToMB(file.size)} MB — max is ${bytesToMB(spec.max_bytes)} MB.`);
          return;
        }
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        setImageDataUrl(dataUrl);
        setImageBytes(file.size);
      } else {
        // Native: use expo-image-picker.
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          setError("Photo library permission is required to upload an ad image.");
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.9,
          base64: true,
          allowsMultipleSelection: false,
        });
        if (result.canceled) return;
        const asset = result.assets?.[0];
        if (!asset?.base64) return;
        const mime = asset.mimeType || "image/jpeg";
        const dataUrl = `data:${mime};base64,${asset.base64}`;
        const bytes = Math.floor((asset.base64.length * 3) / 4);
        if (spec && bytes > spec.max_bytes) {
          setError(`Image is ~${bytesToMB(bytes)} MB — max is ${bytesToMB(spec.max_bytes)} MB.`);
          return;
        }
        setImageDataUrl(dataUrl);
        setImageBytes(bytes);
      }
    } catch (e: any) {
      setError(e?.message || "Could not read the selected image");
    } finally {
      setPickingImage(false);
    }
  }, [spec]);

  // -------- save / clear -----------------------------------------------------
  const save = useCallback(async () => {
    setError(null);
    if (!imageDataUrl) { setError("Please upload an image."); return; }
    if (!dealershipId) { setError("Please select an advertiser (dealership)."); return; }
    if (!months || months < 1) { setError("Duration must be at least 1 month."); return; }
    setSaving(true);
    try {
      await apiFetch(`/api/admin/ads/${slot.slot_number}`, {
        method: "PUT",
        body: JSON.stringify({
          image_base64: imageDataUrl,
          dealership_id: dealershipId,
          duration_months: months,
        }),
      });
      onSaved();
    } catch (e: any) {
      setError(e?.message || "Could not save the ad.");
    } finally {
      setSaving(false);
    }
  }, [imageDataUrl, dealershipId, months, slot.slot_number, onSaved]);

  const clear = useCallback(async () => {
    if (!slot.has_image) { onClose(); return; }
    setError(null); setDeleting(true);
    try {
      await apiFetch(`/api/admin/ads/${slot.slot_number}`, { method: "DELETE" });
      onSaved();
    } catch (e: any) {
      setError(e?.message || "Could not clear the ad.");
    } finally {
      setDeleting(false);
    }
  }, [slot.slot_number, slot.has_image, onSaved, onClose]);

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, isWide && styles.modalCardWide]}>
          {/* Modal header */}
          <View style={styles.modalHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.modalEyebrow}>SLOT {slot.slot_number}</Text>
              <Text style={styles.modalTitle}>Edit advertising placement</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.iconClose} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView
            contentContainerStyle={{ paddingBottom: spacing.md }}
            style={{ maxHeight: isWide ? 620 : 500 }}
            showsVerticalScrollIndicator
          >
            {/* Image preview + upload */}
            <View style={styles.formSection}>
              <Text style={styles.label}>Advertising image</Text>
              <Text style={styles.help}>
                {spec
                  ? `${spec.aspect_ratio} · ${spec.recommended_width}×${spec.recommended_height}px · max ${bytesToMB(spec.max_bytes)} MB · ${spec.formats.join("/")}`
                  : ""}
              </Text>
              <View style={styles.imagePreviewWrap}>
                {imageDataUrl ? (
                  <Image source={{ uri: imageDataUrl }} style={styles.imagePreview} resizeMode="cover" />
                ) : (
                  <View style={styles.imagePreviewEmpty}>
                    <Ionicons name="cloud-upload-outline" size={36} color={colors.textSecondary} />
                    <Text style={styles.imagePreviewEmptyTxt}>No image selected</Text>
                  </View>
                )}
              </View>
              <TouchableOpacity style={styles.uploadBtn} onPress={pickImage} disabled={pickingImage}>
                {pickingImage ? (
                  <ActivityIndicator size="small" color={colors.text} />
                ) : (
                  <>
                    <Ionicons name="image-outline" size={16} color={colors.text} />
                    <Text style={styles.uploadBtnTxt}>{imageDataUrl ? "Replace image" : "Upload image"}</Text>
                  </>
                )}
              </TouchableOpacity>
              {imageBytes > 0 ? (
                <Text style={styles.help}>Selected: {bytesToMB(imageBytes)} MB</Text>
              ) : null}
            </View>

            {/* Dealership dropdown */}
            <View style={styles.formSection}>
              <Text style={styles.label}>Advertiser (registered dealership)</Text>
              <TouchableOpacity
                style={styles.dropdownBtn}
                onPress={() => setShowDealerDropdown((v) => !v)}
              >
                <Text style={[styles.dropdownTxt, !selectedDealer && { color: colors.textSecondary }]}>
                  {selectedDealer?.name || "Select a dealership…"}
                </Text>
                <Ionicons
                  name={showDealerDropdown ? "chevron-up" : "chevron-down"}
                  size={16}
                  color={colors.text}
                />
              </TouchableOpacity>
              {showDealerDropdown ? (
                <View style={styles.dropdownList}>
                  <ScrollView style={{ maxHeight: 260 }} nestedScrollEnabled>
                    {dealerships.length === 0 ? (
                      <View style={styles.dropdownEmpty}>
                        <Text style={styles.dropdownEmptyTxt}>No dealerships found.</Text>
                      </View>
                    ) : (
                      dealerships.map((d) => (
                        <TouchableOpacity
                          key={d.id}
                          style={[
                            styles.dropdownItem,
                            d.id === dealershipId && styles.dropdownItemActive,
                          ]}
                          onPress={() => { setDealershipId(d.id); setShowDealerDropdown(false); }}
                        >
                          <Text
                            style={[
                              styles.dropdownItemTxt,
                              d.id === dealershipId && styles.dropdownItemTxtActive,
                            ]}
                            numberOfLines={1}
                          >
                            {d.name}
                          </Text>
                          {d.active === false ? (
                            <Text style={styles.dropdownInactive}>inactive</Text>
                          ) : null}
                          {d.id === dealershipId ? (
                            <Ionicons name="checkmark" size={16} color={colors.primary} />
                          ) : null}
                        </TouchableOpacity>
                      ))
                    )}
                  </ScrollView>
                </View>
              ) : null}
            </View>

            {/* Duration & cost */}
            <View style={styles.formSection}>
              <Text style={styles.label}>Duration (months)</Text>
              <View style={styles.stepperRow}>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setMonths((m) => Math.max(1, m - 1))}
                >
                  <Ionicons name="remove" size={16} color={colors.text} />
                </TouchableOpacity>
                <View style={styles.stepperValueWrap}>
                  <Text style={styles.stepperValue}>{months}</Text>
                  <Text style={styles.stepperLabel}>{months === 1 ? "month" : "months"}</Text>
                </View>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setMonths((m) => Math.min(60, m + 1))}
                >
                  <Ionicons name="add" size={16} color={colors.text} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Cost summary */}
            <View style={styles.costCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.costLbl}>
                  {isExtension ? "Extension amount" : "Total amount"}
                </Text>
                <Text style={styles.costVal}>{fmtZAR(cost)}</Text>
                <Text style={styles.costHint}>
                  {`${months} × ${fmtZAR(monthlyFee)} per month · billed to ${selectedDealer?.name || "the selected dealership"}`}
                </Text>
                {isExtension ? (
                  <Text style={styles.costHint}>
                    Slot is currently active for this dealer — this will extend the run.
                  </Text>
                ) : null}
              </View>
              <Ionicons name="cash" size={30} color={colors.success} />
            </View>

            {error ? (
              <View style={styles.errorRow}>
                <Ionicons name="alert-circle" size={16} color={colors.danger} />
                <Text style={styles.errorTxt}>{error}</Text>
              </View>
            ) : null}
          </ScrollView>

          {/* Footer buttons */}
          <View style={styles.modalFooter}>
            {slot.has_image ? (
              <TouchableOpacity
                style={styles.footerBtnDanger}
                onPress={clear}
                disabled={deleting || saving}
              >
                {deleting ? (
                  <ActivityIndicator size="small" color={colors.danger} />
                ) : (
                  <>
                    <Ionicons name="trash-outline" size={14} color={colors.danger} />
                    <Text style={styles.footerBtnDangerTxt}>Clear slot</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : <View style={{ flex: 1 }} />}
            <TouchableOpacity style={styles.footerBtnSecondary} onPress={onClose} disabled={saving}>
              <Text style={styles.footerBtnSecondaryTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.footerBtnPrimary, (saving || !imageDataUrl || !dealershipId) && { opacity: 0.5 }]}
              onPress={save}
              disabled={saving || !imageDataUrl || !dealershipId}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <>
                  <Ionicons name="checkmark" size={16} color="#000" />
                  <Text style={styles.footerBtnPrimaryTxt}>
                    {isExtension ? "Extend & bill" : "Save & bill"}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------
function makeStyles(colors: Palette) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    scroll: { padding: spacing.lg, gap: spacing.lg },

    headerRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.md,
      marginBottom: spacing.sm,
    },
    eyebrow: { ...fonts.eyebrow, color: colors.textSecondary, fontSize: 11, letterSpacing: 2 },
    title: { ...fonts.h1, color: colors.text, fontSize: 24, marginTop: 2 },
    sub: { color: colors.textSecondary, fontSize: 13, marginTop: 4, lineHeight: 19 },
    subStrong: { color: colors.text, fontWeight: "700" },
    refreshBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: 8,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
    },
    refreshTxt: { color: colors.text, fontSize: 13, fontWeight: "600" },

    specCard: {
      backgroundColor: colors.paper,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      gap: spacing.sm,
    },
    specRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    specTitle: { color: colors.text, fontSize: 14, fontWeight: "700" },
    specGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
    specItem: { minWidth: 150 },
    specLbl: { color: colors.textSecondary, fontSize: 11, letterSpacing: 1, fontWeight: "700" },
    specVal: { color: colors.text, fontSize: 14, fontWeight: "600", marginTop: 2 },

    errorRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: "rgba(255,80,80,0.10)",
      borderWidth: 1,
      borderColor: "rgba(255,80,80,0.30)",
    },
    errorTxt: { flex: 1, color: colors.danger, fontSize: 13 },

    loadingWrap: { padding: spacing.xl, alignItems: "center" },

    // --- grid ---
    grid: { flexDirection: "column", gap: spacing.md },
    gridWide: { flexDirection: "row", flexWrap: "wrap" },

    card: {
      backgroundColor: colors.paper,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: "hidden",
      width: "100%",
      // 5 columns on ultra-wide, sensible fallback via minWidth
      minWidth: 220,
      flexBasis: "18%",
      flexGrow: 1,
      maxWidth: 320,
      ...Platform.select({
        web: { cursor: "pointer" as any },
      }),
    },
    cardImgWrap: { width: "100%", aspectRatio: 16 / 10, backgroundColor: "#111", overflow: "hidden" },
    cardImg: { width: "100%", height: "100%" },
    cardImgEmpty: {
      width: "100%", height: "100%",
      alignItems: "center", justifyContent: "center", gap: 4,
      backgroundColor: colors.paperElevated || "#141414",
      borderStyle: "dashed",
      borderColor: colors.border,
      borderWidth: 1,
    },
    cardImgEmptyTxt: { color: colors.textSecondary, fontSize: 12 },
    statusPill: {
      position: "absolute", top: 8, right: 8,
      paddingHorizontal: 8, paddingVertical: 3,
      borderRadius: radius.pill,
    },
    statusPillTxt: { fontSize: 10, fontWeight: "800", letterSpacing: 1 },
    slotNumChip: {
      position: "absolute", top: 8, left: 8,
      paddingHorizontal: 8, paddingVertical: 3,
      borderRadius: radius.pill,
      backgroundColor: "rgba(0,0,0,0.55)",
    },
    slotNumChipTxt: { color: "#fff", fontSize: 10, fontWeight: "800", letterSpacing: 1 },

    cardBody: { padding: spacing.sm, gap: 3 },
    cardDealer: { color: colors.text, fontSize: 14, fontWeight: "700" },
    cardMetaRow: { flexDirection: "row", alignItems: "center", gap: 4 },
    cardMeta: { color: colors.textSecondary, fontSize: 12 },

    // --- modal ---
    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.65)",
      justifyContent: "center",
      alignItems: "center",
      padding: spacing.lg,
    },
    modalCard: {
      backgroundColor: colors.paper,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      width: "100%",
      maxWidth: 520,
      padding: spacing.lg,
      gap: spacing.md,
    },
    modalCardWide: { maxWidth: 640 },
    modalHeader: { flexDirection: "row", alignItems: "flex-start" },
    modalEyebrow: { color: colors.textSecondary, fontSize: 11, letterSpacing: 2, fontWeight: "800" },
    modalTitle: { ...fonts.h1, color: colors.text, fontSize: 20, marginTop: 2 },
    iconClose: { padding: 4 },

    formSection: { gap: 6, marginBottom: spacing.md },
    label: { color: colors.text, fontSize: 13, fontWeight: "700" },
    help: { color: colors.textSecondary, fontSize: 12 },

    imagePreviewWrap: {
      width: "100%",
      aspectRatio: 16 / 10,
      borderRadius: radius.md,
      overflow: "hidden",
      backgroundColor: "#111",
      borderWidth: 1,
      borderColor: colors.border,
      marginTop: 4,
    },
    imagePreview: { width: "100%", height: "100%" },
    imagePreviewEmpty: {
      width: "100%", height: "100%",
      alignItems: "center", justifyContent: "center", gap: 6,
      borderStyle: "dashed", borderWidth: 1, borderColor: colors.border,
    },
    imagePreviewEmptyTxt: { color: colors.textSecondary, fontSize: 13 },
    uploadBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 10,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.paperElevated || "rgba(255,255,255,0.03)",
      marginTop: 8,
    },
    uploadBtnTxt: { color: colors.text, fontSize: 13, fontWeight: "700" },

    dropdownBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.md,
      paddingVertical: 12,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.paperElevated || "rgba(255,255,255,0.03)",
    },
    dropdownTxt: { color: colors.text, fontSize: 14, fontWeight: "600" },
    dropdownList: {
      borderWidth: 1, borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.paper,
      marginTop: 4,
      overflow: "hidden",
    },
    dropdownItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      borderBottomWidth: 1, borderBottomColor: colors.border,
    },
    dropdownItemActive: { backgroundColor: "rgba(255,255,255,0.05)" },
    dropdownItemTxt: { color: colors.text, fontSize: 13, flex: 1 },
    dropdownItemTxtActive: { fontWeight: "700" },
    dropdownInactive: { color: colors.textSecondary, fontSize: 10, letterSpacing: 1, fontWeight: "700" },
    dropdownEmpty: { padding: spacing.md, alignItems: "center" },
    dropdownEmptyTxt: { color: colors.textSecondary, fontSize: 13 },

    stepperRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      marginTop: 4,
    },
    stepperBtn: {
      width: 40, height: 40, borderRadius: 20,
      alignItems: "center", justifyContent: "center",
      borderWidth: 1, borderColor: colors.border,
      backgroundColor: colors.paperElevated || "rgba(255,255,255,0.03)",
    },
    stepperValueWrap: { alignItems: "center", justifyContent: "center", minWidth: 80 },
    stepperValue: {
      color: colors.text, fontSize: 24, fontWeight: "800", fontFamily: fonts.number, fontVariant: ["tabular-nums"],
    },
    stepperLabel: { color: colors.textSecondary, fontSize: 12, letterSpacing: 1, fontWeight: "700" },

    costCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: "rgba(46,204,113,0.08)",
      borderWidth: 1,
      borderColor: "rgba(46,204,113,0.25)",
    },
    costLbl: { color: colors.textSecondary, fontSize: 11, letterSpacing: 1, fontWeight: "800" },
    costVal: { color: colors.text, fontSize: 26, fontWeight: "800", fontFamily: fonts.number, fontVariant: ["tabular-nums"], marginTop: 2 },
    costHint: { color: colors.textSecondary, fontSize: 12, marginTop: 4, lineHeight: 17 },

    modalFooter: {
      flexDirection: "row",
      gap: spacing.sm,
      alignItems: "center",
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: spacing.md,
    },
    footerBtnDanger: {
      flexDirection: "row",
      alignItems: "center", justifyContent: "center",
      gap: 4,
      paddingHorizontal: spacing.md, paddingVertical: 10,
      borderRadius: radius.md,
      borderWidth: 1, borderColor: "rgba(255,80,80,0.4)",
    },
    footerBtnDangerTxt: { color: colors.danger, fontSize: 13, fontWeight: "700" },
    footerBtnSecondary: {
      paddingHorizontal: spacing.md, paddingVertical: 10,
      borderRadius: radius.md,
      borderWidth: 1, borderColor: colors.border,
    },
    footerBtnSecondaryTxt: { color: colors.text, fontSize: 13, fontWeight: "700" },
    footerBtnPrimary: {
      flexDirection: "row",
      alignItems: "center", justifyContent: "center",
      gap: 6,
      paddingHorizontal: spacing.lg, paddingVertical: 12,
      borderRadius: radius.md,
      backgroundColor: colors.primary,
    },
    footerBtnPrimaryTxt: { color: colors.onPrimary || "#000", fontSize: 14, fontWeight: "800" },
  });
}
