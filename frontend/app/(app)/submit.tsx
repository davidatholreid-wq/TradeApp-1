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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { storage } from "@/src/utils/storage";
import { SCAN_BUFFER_KEY } from "./scan";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { colors, spacing, radius, fonts } from "@/src/theme";
import { apiFetch } from "@/src/api";
import OptionPicker, { Option } from "@/src/components/OptionPicker";

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

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const buf = await storage.getItem<string>(SCAN_BUFFER_KEY, "");
        if (buf) {
          setLicenseDisk(buf);
          await storage.removeItem(SCAN_BUFFER_KEY);
        }
      })();
    }, [])
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
              <Text style={styles.scanBtnText}>{licenseDisk ? "Scanned" : "Scan license disk barcode"}</Text>
              {licenseDisk ? (
                <Text style={styles.scanBtnHint} numberOfLines={1}>
                  {licenseDisk.substring(0, 40)}...
                </Text>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </TouchableOpacity>

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
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="paper-plane" size={18} color="#fff" />
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
    </SafeAreaView>
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
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: "700", fontFamily: fonts.serif, letterSpacing: 0.3 },
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
  submitBtnText: { color: "#fff", fontWeight: "700", fontSize: 15, letterSpacing: 1, textTransform: "uppercase" },
  disabledBtn: { opacity: 0.6 },
});
