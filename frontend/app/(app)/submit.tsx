import { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Switch,
  Image,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { storage } from "@/src/utils/storage";
import { SCAN_BUFFER_KEY, SCAN_PARSED_KEY } from "./scan";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { colors, spacing, radius, fonts } from "@/src/theme";
import { apiFetch } from "@/src/api";
import OptionPicker, { Option } from "@/src/components/OptionPicker";
import { decodeLicenseDisk, LicenseDiskInfo } from "@/src/utils/licenseDisk";

type PhotoSlot = "front" | "side_right" | "rear" | "side_left" | "interior";
const PHOTO_LABELS: Record<PhotoSlot, string> = {
  front: "Front",
  side_right: "Right Side",
  rear: "Rear",
  side_left: "Left Side",
  interior: "Interior",
};
const PHOTO_SLOTS: PhotoSlot[] = ["front", "side_right", "rear", "side_left", "interior"];

export default function SubmitVehicle() {
  const router = useRouter();
  const tabBarHeight = useBottomTabBarHeight();

  const [make, setMake] = useState<Option | null>(null);
  const [model, setModel] = useState<Option | null>(null);
  const [derivative, setDerivative] = useState<Option | null>(null);
  const [mileage, setMileage] = useState("");
  const [year, setYear] = useState("");
  const [factoryWarranty, setFactoryWarranty] = useState(false);
  const [condition, setCondition] = useState(7);
  const [accidentDamage, setAccidentDamage] = useState(false);
  const [colour, setColour] = useState("");
  const [licenseDisk, setLicenseDisk] = useState<string | null>(null);
  const [licenseDiskInfo, setLicenseDiskInfo] = useState<LicenseDiskInfo | null>(null);
  const [photos, setPhotos] = useState<Record<PhotoSlot, string | null>>({
    front: null,
    side_right: null,
    rear: null,
    side_left: null,
    interior: null,
  });

  const [makesList, setMakesList] = useState<Option[]>([]);
  const [modelsList, setModelsList] = useState<Option[]>([]);
  const [derivativesList, setDerivativesList] = useState<Option[]>([]);
  const [pickerOpen, setPickerOpen] = useState<null | "make" | "model" | "derivative">(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billingConfirmOpen, setBillingConfirmOpen] = useState(false);
  const [billingAckChecked, setBillingAckChecked] = useState(false);

  // Try to auto-match a scanned Make against the DB and, if unique, preload it.
  const autoMatchMake = useCallback(async (rawMakeName: string) => {
    if (!rawMakeName) return;
    try {
      const data = await apiFetch("/api/vehicles/makes");
      const items: Option[] = data.makes || [];
      const needle = rawMakeName.toUpperCase().trim();
      // Exact match first, then startsWith, then contains.
      const match =
        items.find((m) => m.name.toUpperCase() === needle) ||
        items.find((m) => m.name.toUpperCase().startsWith(needle)) ||
        items.find((m) => m.name.toUpperCase().includes(needle));
      if (match) setMake(match);
    } catch {
      /* best-effort */
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const buf = await storage.getItem<string>(SCAN_BUFFER_KEY, "");
        if (buf) {
          setLicenseDisk(buf);
          const parsedStr = await storage.getItem<string>(SCAN_PARSED_KEY, "");
          let parsed: LicenseDiskInfo | null = null;
          if (parsedStr) {
            try {
              parsed = JSON.parse(parsedStr) as LicenseDiskInfo;
            } catch {
              parsed = decodeLicenseDisk(buf);
            }
          } else {
            parsed = decodeLicenseDisk(buf);
          }
          setLicenseDiskInfo(parsed);
          // Auto-fill known form fields (non-destructive: only fills when empty).
          if (parsed?.colour) setColour((prev) => prev || parsed!.colour!);
          if (parsed?.make) autoMatchMake(parsed.make);
          await storage.removeItem(SCAN_BUFFER_KEY);
          await storage.removeItem(SCAN_PARSED_KEY);
        }
      })();
    }, [autoMatchMake])
  );

  const openMakePicker = useCallback(async () => {
    setPickerOpen("make");
    setPickerLoading(true);
    try {
      const data = await apiFetch("/api/vehicles/makes");
      setMakesList(data.makes);
    } finally {
      setPickerLoading(false);
    }
  }, []);

  const openModelPicker = useCallback(async () => {
    if (!make) return;
    setPickerOpen("model");
    setPickerLoading(true);
    try {
      const data = await apiFetch(`/api/vehicles/models?make_id=${make.id}`);
      setModelsList(data.models);
    } finally {
      setPickerLoading(false);
    }
  }, [make]);

  const openDerivativePicker = useCallback(async () => {
    if (!model) return;
    setPickerOpen("derivative");
    setPickerLoading(true);
    try {
      const data = await apiFetch(`/api/vehicles/derivatives?model_id=${model.id}`);
      setDerivativesList(data.derivatives);
    } finally {
      setPickerLoading(false);
    }
  }, [model]);

  const pickPhoto = async (slot: PhotoSlot) => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission required", "Please allow photo access to attach vehicle photos.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.5,
      base64: true,
    });
    if (!result.canceled && result.assets[0].base64) {
      setPhotos((p) => ({ ...p, [slot]: `data:image/jpeg;base64,${result.assets[0].base64}` }));
    }
  };

  const takePhoto = async (slot: PhotoSlot) => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Camera permission required", "Please allow camera access to capture vehicle photos.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.5,
      base64: true,
    });
    if (!result.canceled && result.assets[0].base64) {
      setPhotos((p) => ({ ...p, [slot]: `data:image/jpeg;base64,${result.assets[0].base64}` }));
    }
  };

  const promptPhotoSource = (slot: PhotoSlot) => {
    Alert.alert(PHOTO_LABELS[slot] + " Photo", "Choose a source", [
      { text: "Camera", onPress: () => takePhoto(slot) },
      { text: "Gallery", onPress: () => pickPhoto(slot) },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const validate = (): string | null => {
    if (!make) return "Please select a Make";
    if (!model) return "Please select a Model";
    if (!derivative) return "Please select a Derivative";
    const mi = parseInt(mileage);
    if (isNaN(mi) || mi < 0) return "Enter a valid mileage";
    const yr = parseInt(year);
    if (isNaN(yr) || yr < 1980 || yr > 2030) return "Enter a valid year (1980-2030)";
    if (!colour.trim()) return "Enter the colour";
    for (const slot of PHOTO_SLOTS) {
      if (!photos[slot]) return `Please add a photo for: ${PHOTO_LABELS[slot]}`;
    }
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    // Open the billing-confirmation modal — actual API call happens on confirm.
    setError(null);
    setBillingConfirmOpen(true);
  };

  const performSubmit = async () => {
    setBillingConfirmOpen(false);
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/submissions", {
        method: "POST",
        body: JSON.stringify({
          make_id: make!.id,
          make_name: make!.name,
          model_id: model!.id,
          model_name: model!.name,
          derivative_id: derivative!.id,
          derivative_name: derivative!.name,
          mileage: parseInt(mileage),
          year: parseInt(year),
          factory_warranty: factoryWarranty,
          condition,
          accident_damage: accidentDamage,
          colour: colour.trim(),
          license_disk_data: licenseDisk,
          photos,
          billing_accepted: true,
        }),
      });
      router.replace("/(app)");
    } catch (e: any) {
      setError(e.message || "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  const conditionColor =
    condition <= 3 ? colors.danger : condition <= 7 ? colors.warning : colors.success;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="submit-back-button" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Submit Vehicle</Text>
        <View style={{ width: 32 }} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: tabBarHeight + 24 }]} keyboardShouldPersistTaps="handled">
          {/* Section: Vehicle */}
          <Text style={styles.sectionTitle}>Vehicle</Text>

          <TouchableOpacity
            testID="select-make-button"
            style={styles.selector}
            onPress={openMakePicker}
          >
            <Text style={styles.selectorLabel}>Make</Text>
            <View style={styles.selectorRight}>
              <Text style={[styles.selectorValue, !make && styles.placeholder]}>
                {make?.name || "Select make"}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            testID="select-model-button"
            style={[styles.selector, !make && styles.disabled]}
            onPress={openModelPicker}
            disabled={!make}
          >
            <Text style={styles.selectorLabel}>Model</Text>
            <View style={styles.selectorRight}>
              <Text style={[styles.selectorValue, !model && styles.placeholder]}>
                {model?.name || "Select model"}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            testID="select-derivative-button"
            style={[styles.selector, !model && styles.disabled]}
            onPress={openDerivativePicker}
            disabled={!model}
          >
            <Text style={styles.selectorLabel}>Derivative</Text>
            <View style={styles.selectorRight}>
              <Text style={[styles.selectorValue, !derivative && styles.placeholder]}>
                {derivative?.name || "Select derivative"}
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
            </View>
          </TouchableOpacity>

          {/* Section: Details */}
          <Text style={styles.sectionTitle}>Details</Text>

          <View style={styles.field}>
            <Text style={styles.label}>Mileage (km)</Text>
            <TextInput
              testID="mileage-input"
              style={styles.input}
              value={mileage}
              onChangeText={setMileage}
              keyboardType="number-pad"
              placeholder="e.g. 45000"
              placeholderTextColor={colors.textDisabled}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Year Registered</Text>
            <TextInput
              testID="year-input"
              style={styles.input}
              value={year}
              onChangeText={setYear}
              keyboardType="number-pad"
              placeholder="e.g. 2022"
              placeholderTextColor={colors.textDisabled}
              maxLength={4}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Colour</Text>
            <TextInput
              testID="colour-input"
              style={styles.input}
              value={colour}
              onChangeText={setColour}
              placeholder="e.g. Pearl White"
              placeholderTextColor={colors.textDisabled}
            />
          </View>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Factory Warranty</Text>
              <Text style={styles.toggleHint}>Still under factory warranty</Text>
            </View>
            <Switch
              testID="factory-warranty-toggle"
              value={factoryWarranty}
              onValueChange={setFactoryWarranty}
              trackColor={{ true: colors.primary, false: colors.border }}
            />
          </View>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Accident Damage</Text>
              <Text style={styles.toggleHint}>Vehicle has been in an accident</Text>
            </View>
            <Switch
              testID="accident-damage-toggle"
              value={accidentDamage}
              onValueChange={setAccidentDamage}
              trackColor={{ true: colors.danger, false: colors.border }}
            />
          </View>

          {/* Condition */}
          <Text style={styles.sectionTitle}>Condition</Text>
          <View style={styles.conditionBox}>
            <View style={styles.conditionHeader}>
              <Text style={styles.label}>Rate 1-10</Text>
              <Text style={[styles.conditionValue, { color: conditionColor }]} testID="condition-value">
                {condition}/10
              </Text>
            </View>
            <View style={styles.conditionRow}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => {
                const active = n <= condition;
                const nColor = n <= 3 ? colors.danger : n <= 7 ? colors.warning : colors.success;
                return (
                  <TouchableOpacity
                    key={n}
                    testID={`condition-${n}`}
                    onPress={() => setCondition(n)}
                    style={[
                      styles.conditionDot,
                      { backgroundColor: active ? nColor : colors.card, borderColor: active ? nColor : colors.border },
                    ]}
                  >
                    <Text style={[styles.conditionDotText, { color: active ? "#000" : colors.textSecondary }]}>
                      {n}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* License disk scan */}
          <Text style={styles.sectionTitle}>License Disk (optional)</Text>
          <TouchableOpacity
            testID="scan-license-disk-button"
            style={styles.scanBtn}
            onPress={() =>
              router.push({
                pathname: "/(app)/scan",
                params: { returnPath: "submit" },
              } as any)
            }
          >
            <Ionicons name="barcode-outline" size={24} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.scanBtnText}>
                {licenseDisk ? (licenseDiskInfo?.vin ? "Decoded" : "Scanned") : "Scan license disk barcode"}
              </Text>
              {licenseDisk ? (
                <Text style={styles.scanBtnHint} numberOfLines={1}>
                  Tap to re-scan
                </Text>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </TouchableOpacity>

          {licenseDiskInfo && (licenseDiskInfo.vin || licenseDiskInfo.make || licenseDiskInfo.licenceNo) ? (
            <View style={styles.diskCard} testID="license-disk-decoded-card">
              <View style={styles.diskCardHeader}>
                <Ionicons name="shield-checkmark" size={16} color={colors.primary} />
                <Text style={styles.diskCardTitle}>Decoded from disc</Text>
                <TouchableOpacity
                  testID="clear-license-disk"
                  onPress={() => {
                    setLicenseDisk(null);
                    setLicenseDiskInfo(null);
                  }}
                  style={styles.diskClearBtn}
                >
                  <Ionicons name="close" size={14} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <View style={styles.diskGrid}>
                {licenseDiskInfo.licenceNo ? (
                  <DiskField label="Licence No" value={licenseDiskInfo.licenceNo} />
                ) : null}
                {licenseDiskInfo.vehicleRegisterNo ? (
                  <DiskField label="Register No" value={licenseDiskInfo.vehicleRegisterNo} />
                ) : null}
                {licenseDiskInfo.make ? <DiskField label="Make" value={licenseDiskInfo.make} /> : null}
                {licenseDiskInfo.model ? <DiskField label="Model" value={licenseDiskInfo.model} /> : null}
                {licenseDiskInfo.colour ? (
                  <DiskField label="Colour" value={licenseDiskInfo.colour} />
                ) : null}
                {licenseDiskInfo.vin ? (
                  <DiskField label="VIN" value={licenseDiskInfo.vin} mono full />
                ) : null}
                {licenseDiskInfo.engineNo ? (
                  <DiskField label="Engine No" value={licenseDiskInfo.engineNo} mono />
                ) : null}
                {licenseDiskInfo.vehicleDescription ? (
                  <DiskField label="Description" value={licenseDiskInfo.vehicleDescription} full />
                ) : null}
                {licenseDiskInfo.expiryDate ? (
                  <DiskField label="Expires" value={licenseDiskInfo.expiryDate} mono />
                ) : null}
                {licenseDiskInfo.licenceDiscNo ? (
                  <DiskField label="Disc No" value={licenseDiskInfo.licenceDiscNo} mono full />
                ) : null}
              </View>
              <Text style={styles.diskHint}>
                Values auto-filled where possible — please verify against the disc before submitting.
              </Text>
            </View>
          ) : null}

          {/* Photos */}
          <Text style={styles.sectionTitle}>Photos (5 required)</Text>
          <View style={styles.photoGrid}>
            {PHOTO_SLOTS.map((slot) => (
              <TouchableOpacity
                key={slot}
                testID={`photo-slot-${slot}`}
                style={styles.photoSlot}
                onPress={() => promptPhotoSource(slot)}
                activeOpacity={0.7}
              >
                {photos[slot] ? (
                  <>
                    <Image source={{ uri: photos[slot]! }} style={styles.photoImg} />
                    <View style={styles.photoOverlay}>
                      <Text style={styles.photoLabelActive}>{PHOTO_LABELS[slot]}</Text>
                    </View>
                  </>
                ) : (
                  <>
                    <Ionicons name="camera-outline" size={28} color={colors.textSecondary} />
                    <Text style={styles.photoLabel}>{PHOTO_LABELS[slot]}</Text>
                  </>
                )}
              </TouchableOpacity>
            ))}
          </View>

          {error ? (
            <Text style={styles.error} testID="submit-error">
              {error}
            </Text>
          ) : null}

          <TouchableOpacity
            testID="submit-vehicle-button"
            style={[styles.submitBtn, submitting && styles.disabledBtn]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#000" />
            ) : (
              <>
                <Ionicons name="paper-plane" size={18} color="#000" />
                <Text style={styles.submitBtnText}>Submit for Pricing</Text>
              </>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      <OptionPicker
        visible={pickerOpen === "make"}
        title="Select Make"
        options={makesList}
        loading={pickerLoading}
        onClose={() => setPickerOpen(null)}
        onSelect={(o) => {
          setMake(o);
          setModel(null);
          setDerivative(null);
          setPickerOpen(null);
        }}
        testID="make-picker"
      />
      <OptionPicker
        visible={pickerOpen === "model"}
        title="Select Model"
        options={modelsList}
        loading={pickerLoading}
        onClose={() => setPickerOpen(null)}
        onSelect={(o) => {
          setModel(o);
          setDerivative(null);
          setPickerOpen(null);
        }}
        testID="model-picker"
      />
      <OptionPicker
        visible={pickerOpen === "derivative"}
        title="Select Derivative"
        options={derivativesList}
        loading={pickerLoading}
        onClose={() => setPickerOpen(null)}
        onSelect={(o) => {
          setDerivative(o);
          setPickerOpen(null);
        }}
        testID="derivative-picker"
      />

      {/* Billing confirmation — shown for EVERY submission before we POST. */}
      <Modal
        visible={billingConfirmOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setBillingConfirmOpen(false)}
      >
        <View style={styles.billBackdrop}>
          <View style={styles.billCard} testID="billing-confirm-modal">
            <View style={styles.billHeader}>
              <Ionicons name="cash-outline" size={22} color={colors.neon} />
              <Text style={styles.billTitle}>Confirm Submission</Text>
            </View>
            <View style={styles.billBody}>
              <Text style={styles.billLine}>
                You are about to submit a vehicle for pricing.
              </Text>
              <View style={styles.billFeeBox}>
                <Text style={styles.billFeeAmount}>R50.00</Text>
                <Text style={styles.billFeeCaption}>per priced submission · incl. VAT</Text>
              </View>
              <Text style={styles.billNote}>
                <Text style={styles.billStrong}>No fee</Text> if Fourbuy does not
                return a price within{" "}
                <Text style={styles.billStrong}>24 hours</Text> of your submission.
              </Text>

              <TouchableOpacity
                testID="billing-confirm-check"
                style={styles.billCheckRow}
                onPress={() => setBillingAckChecked((v) => !v)}
                activeOpacity={0.8}
              >
                <View style={[styles.billCheckbox, billingAckChecked && styles.billCheckboxChecked]}>
                  {billingAckChecked ? (
                    <Ionicons name="checkmark" size={14} color="#000" />
                  ) : null}
                </View>
                <Text style={styles.billCheckLabel}>
                  I understand and agree to the R50 fee for this submission.
                </Text>
              </TouchableOpacity>
            </View>
            <View style={styles.billFooter}>
              <TouchableOpacity
                testID="billing-confirm-cancel"
                style={styles.billCancelBtn}
                onPress={() => {
                  setBillingConfirmOpen(false);
                  setBillingAckChecked(false);
                }}
              >
                <Text style={styles.billCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="billing-confirm-submit"
                style={[styles.billSubmitBtn, !billingAckChecked && { opacity: 0.4 }]}
                onPress={() => {
                  if (!billingAckChecked) return;
                  setBillingAckChecked(false);
                  performSubmit();
                }}
                disabled={!billingAckChecked}
                activeOpacity={0.85}
              >
                <Ionicons name="paper-plane" size={16} color="#000" />
                <Text style={styles.billSubmitText}>Confirm & Submit</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function DiskField({
  label,
  value,
  mono,
  full,
}: {
  label: string;
  value: string;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <View
      style={[
        styles.diskField,
        full && { flexBasis: "100%", minWidth: "100%", width: "100%" },
      ]}
    >
      <Text style={styles.diskFieldLabel}>{label.toUpperCase()}</Text>
      <Text
        style={[
          styles.diskFieldValue,
          mono && styles.diskFieldValueMono,
        ]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
        ellipsizeMode="middle"
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
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
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 2, textTransform: "uppercase" },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  selector: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  selectorLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: "500" },
  selectorRight: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, justifyContent: "flex-end" },
  selectorValue: { color: colors.text, fontSize: 15, fontWeight: "600" },
  placeholder: { color: colors.textDisabled, fontWeight: "400" },
  disabled: { opacity: 0.5 },
  field: { marginBottom: spacing.sm },
  label: { color: colors.textSecondary, fontSize: 13, marginBottom: 6 },
  input: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    color: colors.text,
    fontSize: 16,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  toggleLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  toggleHint: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  conditionBox: {
    padding: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  conditionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm },
  conditionValue: { fontSize: 18, fontWeight: "800", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  conditionRow: { flexDirection: "row", justifyContent: "space-between", gap: 4 },
  conditionDot: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  conditionDotText: { fontSize: 13, fontWeight: "700" },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  scanBtnText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  scanBtnHint: { color: colors.textSecondary, fontSize: 12, marginTop: 2, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },

  diskCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.primary + "55",
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  diskCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: spacing.sm,
  },
  diskCardTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  diskClearBtn: {
    padding: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  diskGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  diskField: {
    minWidth: "45%",
    flexGrow: 1,
    flexShrink: 1,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.paper,
  },
  diskFieldLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
    marginBottom: 4,
  },
  diskFieldValue: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  diskFieldValueMono: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    letterSpacing: 0,
    fontWeight: "600",
  },
  diskHint: {
    color: colors.textDisabled,
    fontSize: 11,
    fontStyle: "italic",
    marginTop: 4,
  },
  photoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  photoSlot: {
    width: "48%",
    aspectRatio: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  photoImg: { width: "100%", height: "100%" },
  photoOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingVertical: 6,
    alignItems: "center",
  },
  photoLabel: { color: colors.textSecondary, fontSize: 12, marginTop: 6, fontWeight: "600" },
  photoLabelActive: { color: "#fff", fontSize: 12, fontWeight: "700" },
  error: { color: colors.danger, marginTop: spacing.md, fontSize: 14 },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 16,
    marginTop: spacing.lg,
  },
  submitBtnText: { color: "#000", fontWeight: "800", fontSize: 15, letterSpacing: 1.5, textTransform: "uppercase" },
  disabledBtn: { opacity: 0.6 },

  // Billing confirmation modal
  billBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  billCard: {
    width: "100%",
    maxWidth: 440,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.neon + "88",
    overflow: "hidden",
  },
  billHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.paper,
  },
  billTitle: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  billBody: { padding: spacing.md },
  billLine: { color: colors.text, fontSize: 14, lineHeight: 20, marginBottom: spacing.md, textAlign: "center" },
  billFeeBox: {
    alignItems: "center",
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.neon + "55",
    borderRadius: radius.md,
    backgroundColor: colors.neon + "10",
    marginBottom: spacing.md,
  },
  billFeeAmount: { color: colors.neon, fontSize: 34, fontWeight: "800", letterSpacing: 1 },
  billFeeCaption: { color: colors.textSecondary, fontSize: 12, marginTop: 4, letterSpacing: 0.5 },
  billNote: { color: colors.text, fontSize: 13, lineHeight: 20, textAlign: "center", marginBottom: spacing.md },
  billStrong: { color: colors.neon, fontWeight: "800" },
  billCheckRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.paper,
  },
  billCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  billCheckboxChecked: { backgroundColor: colors.neon, borderColor: colors.neon },
  billCheckLabel: { color: colors.text, fontSize: 13, flex: 1, lineHeight: 18 },
  billFooter: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.paper,
  },
  billCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    backgroundColor: colors.card,
  },
  billCancelText: { color: colors.textSecondary, fontWeight: "700", fontSize: 13 },
  billSubmitBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  billSubmitText: { color: "#000", fontWeight: "800", fontSize: 14, letterSpacing: 1, textTransform: "uppercase" },
});
