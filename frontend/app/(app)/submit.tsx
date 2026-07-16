import { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
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
import WheelPicker from "@/src/components/WheelPicker";
import { decodeLicenseDisk, LicenseDiskInfo } from "@/src/utils/licenseDisk";

type PhotoKey = "front" | "driver_side" | "passenger_side" | "rear" | "interior";
const PHOTO_ORDER: { key: PhotoKey; label: string }[] = [
  { key: "front", label: "Front" },
  { key: "driver_side", label: "Driver's Side" },
  { key: "passenger_side", label: "Passenger Side" },
  { key: "rear", label: "Rear" },
  { key: "interior", label: "Interior" },
];

const WINDSCREEN_OPTIONS = ["Perfect", "Chip", "Crack", "Needs Replacement"] as const;
type Windscreen = typeof WINDSCREEN_OPTIONS[number];
const SERVICE_HISTORY = [
  "Full Service History with Agents",
  "Full Service History with Agents & Non-Agents",
  "Partial Service History",
  "No Service History",
] as const;
type ServiceHistory = typeof SERVICE_HISTORY[number];
const COLOURS = ["White", "Black", "Silver", "Grey", "Blue", "Red", "Green", "Yellow", "Orange", "Brown", "Beige", "Gold", "Maroon"];

type WheelField =
  | "make" | "fuel_type" | "year_of_production" | "transmission"
  | "model" | "derivative" | "year_registered" | "colour"
  | "windscreen_condition" | "service_history";

export default function SubmitVehicle() {
  const router = useRouter();
  const tabBarHeight = useBottomTabBarHeight();

  // Progressive-filter picks
  const [make, setMake] = useState<string | null>(null);
  const [fuelType, setFuelType] = useState<string | null>(null);
  const [yearOfProduction, setYearOfProduction] = useState<number | null>(null);
  const [transmission, setTransmission] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [derivative, setDerivative] = useState<string | null>(null);
  const [yearRegistered, setYearRegistered] = useState<number | null>(null);

  // Identity (license-disc-scan-fed or manual)
  const [licenseDisk, setLicenseDisk] = useState<string | null>(null);
  const [licenseDiskInfo, setLicenseDiskInfo] = useState<LicenseDiskInfo | null>(null);
  const [colour, setColour] = useState<string | null>(null);
  const [vin, setVin] = useState<string>("TBC");
  const [engineNo, setEngineNo] = useState<string>("TBC");

  // Condition
  const [exteriorRating, setExteriorRating] = useState<number>(7);
  const [interiorRating, setInteriorRating] = useState<number>(7);
  const [tyreRating, setTyreRating] = useState<number>(7);
  const [windscreen, setWindscreen] = useState<Windscreen>("Perfect");

  // Service
  const [serviceHistory, setServiceHistory] = useState<ServiceHistory>("Full Service History with Agents");
  const [lastServiceDate, setLastServiceDate] = useState<string>("");
  const [lastServiceMileage, setLastServiceMileage] = useState<string>("");

  // Photos + mileage
  const [photos, setPhotos] = useState<Record<PhotoKey, string>>({ front: "", driver_side: "", passenger_side: "", rear: "", interior: "" });
  const [mileage, setMileage] = useState<string>("");

  // Damage / paint
  const [paintEvidence, setPaintEvidence] = useState(false);
  const [accidentDamage, setAccidentDamage] = useState(false);

  // Reconditioning items
  const [reconItems, setReconItems] = useState<{ label: string; amount: string }[]>([]);

  // Wheel state + option cache
  const [wheelField, setWheelField] = useState<WheelField | null>(null);
  const [options, setOptions] = useState<{ makes: string[]; fuel_types: string[]; years: number[]; transmissions: string[]; models: string[]; derivatives: string[] }>({ makes: [], fuel_types: [], years: [], transmissions: [], models: [], derivatives: [] });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billingConfirmOpen, setBillingConfirmOpen] = useState(false);
  const [billingAckChecked, setBillingAckChecked] = useState(false);

  // Fetch options with current filters applied. Called before opening each wheel.
  const fetchOptions = useCallback(async (partial: Partial<Record<string, any>>) => {
    const params = new URLSearchParams();
    if (partial.make ?? make) params.set("make", partial.make ?? make ?? "");
    if (partial.fuel_type ?? fuelType) params.set("fuel_type", partial.fuel_type ?? fuelType ?? "");
    const y = partial.year_of_production ?? yearOfProduction;
    if (y != null) params.set("year_of_production", String(y));
    if (partial.transmission ?? transmission) params.set("transmission", partial.transmission ?? transmission ?? "");
    if (partial.model ?? model) params.set("model", partial.model ?? model ?? "");
    const q = params.toString();
    const data = await apiFetch(`/api/vehicles/options${q ? "?" + q : ""}`);
    setOptions({
      makes: data.makes || [],
      fuel_types: data.fuel_types || [],
      years: data.years || [],
      transmissions: data.transmissions || [],
      models: data.models || [],
      derivatives: data.derivatives || [],
    });
  }, [make, fuelType, yearOfProduction, transmission, model]);

  const openWheel = async (field: WheelField) => {
    // For the discrete pickers, we don't need to hit the API.
    if (field !== "windscreen_condition" && field !== "service_history" && field !== "colour" && field !== "year_registered") {
      await fetchOptions({});
    }
    setWheelField(field);
  };

  // Whenever the picks change, clear downstream fields that no longer apply.
  const setMakePick = (v: string) => { setMake(v); setFuelType(null); setYearOfProduction(null); setTransmission(null); setModel(null); setDerivative(null); };
  const setFuelPick = (v: string) => { setFuelType(v); setYearOfProduction(null); setTransmission(null); setModel(null); setDerivative(null); };
  const setYearPick = (v: number) => { setYearOfProduction(v); setTransmission(null); setModel(null); setDerivative(null); };
  const setTransPick = (v: string) => { setTransmission(v); setModel(null); setDerivative(null); };
  const setModelPick = (v: string) => { setModel(v); setDerivative(null); };

  // ------ License disc parsing on focus ------
  useFocusEffect(
    useCallback(() => {
      (async () => {
        const buf = await storage.getItem<string>(SCAN_BUFFER_KEY, "");
        if (buf) {
          setLicenseDisk(buf);
          const parsedStr = await storage.getItem<string>(SCAN_PARSED_KEY, "");
          let parsed: LicenseDiskInfo | null = null;
          try { parsed = parsedStr ? JSON.parse(parsedStr) : decodeLicenseDisk(buf); } catch { parsed = decodeLicenseDisk(buf); }
          setLicenseDiskInfo(parsed);
          if (parsed?.colour) setColour((prev) => prev || parsed!.colour!);
          if (parsed?.vin) setVin(parsed.vin);
          if (parsed?.engineNo) setEngineNo(parsed.engineNo);
          await storage.removeItem(SCAN_BUFFER_KEY);
          await storage.removeItem(SCAN_PARSED_KEY);
        }
      })();
    }, [])
  );

  const pickPhoto = async (key: PhotoKey) => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission required", "Photo library access is needed to attach images.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.5, allowsEditing: true, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets?.[0]?.base64) return;
    setPhotos((p) => ({ ...p, [key]: `data:image/jpeg;base64,${res.assets![0].base64}` }));
  };

  const addReconItem = () => setReconItems((r) => [...r, { label: "", amount: "" }]);
  const updateReconItem = (i: number, patch: Partial<{ label: string; amount: string }>) => setReconItems((r) => r.map((x, ix) => (ix === i ? { ...x, ...patch } : x)));
  const removeReconItem = (i: number) => setReconItems((r) => r.filter((_, ix) => ix !== i));
  const reconTotal = useMemo(() => reconItems.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0), [reconItems]);

  const validate = (): string | null => {
    if (!make || !fuelType || !yearOfProduction || !transmission || !model || !derivative) return "Please complete all vehicle spec fields.";
    if (!yearRegistered) return "Please choose year registered.";
    if (!mileage || isNaN(parseInt(mileage))) return "Enter mileage.";
    // If no VIN from scan and no manual colour picked → force colour.
    if ((!vin || vin === "TBC") && !colour) return "Please pick a colour (or scan the license disc).";
    for (const p of PHOTO_ORDER) if (!photos[p.key]) return `Photo missing: ${p.label}`;
    return null;
  };

  const handleSubmit = () => {
    const err = validate();
    if (err) { setError(err); return; }
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
          make, fuel_type: fuelType, year_of_production: yearOfProduction, transmission,
          model, derivative, year_registered: yearRegistered,
          colour: colour || (licenseDiskInfo?.colour ?? "TBC"),
          vin: vin || "TBC", engine_number: engineNo || "TBC",
          license_disk_data: licenseDisk,
          exterior_condition: exteriorRating,
          interior_condition: interiorRating,
          tyre_condition: tyreRating,
          windscreen_condition: windscreen,
          service_history: serviceHistory,
          last_service_date: lastServiceDate || null,
          last_service_mileage: lastServiceMileage ? parseInt(lastServiceMileage) : null,
          photos, mileage: parseInt(mileage),
          paint_evidence: paintEvidence,
          accident_damage: accidentDamage,
          reconditioning_items: reconItems.filter(r => r.label.trim() && parseFloat(r.amount) > 0).map(r => ({ label: r.label.trim(), amount_zar: parseFloat(r.amount) })),
          billing_accepted: true,
        }),
      });
      router.replace("/(app)");
    } catch (e: any) { setError(e.message || "Failed to submit"); }
    finally { setSubmitting(false); }
  };

  // -------------------------- UI --------------------------
  const Field = ({ label, value, onPress, testID, hint }: { label: string; value: string | null; onPress: () => void; testID?: string; hint?: string }) => (
    <TouchableOpacity style={styles.field} onPress={onPress} testID={testID} activeOpacity={0.75}>
      <View style={{ flex: 1 }}>
        <Text style={styles.fieldLabel}>{label.toUpperCase()}</Text>
        <Text style={[styles.fieldValue, !value && styles.fieldValuePlaceholder]}>{value ?? hint ?? "Tap to choose"}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
    </TouchableOpacity>
  );

  const RatingDots = ({ value, onChange }: { value: number; onChange: (n: number) => void }) => (
    <View style={styles.dotsRow}>
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
        const active = n <= value;
        return (
          <TouchableOpacity key={n} style={[styles.dot, active && styles.dotActive]} onPress={() => onChange(n)} testID={`rating-${n}`}>
            <Text style={[styles.dotText, active && styles.dotTextActive]}>{n}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  const wheelOptionsFor = (): { title: string; options: any[]; value: any; onSelect: (v: any) => void; formatter?: (v: any) => string } => {
    switch (wheelField) {
      case "make": return { title: "Make", options: options.makes, value: make, onSelect: setMakePick };
      case "fuel_type": return { title: "Fuel Type", options: options.fuel_types, value: fuelType, onSelect: setFuelPick };
      case "year_of_production": return { title: "Year of Production", options: options.years, value: yearOfProduction, onSelect: setYearPick };
      case "transmission": return { title: "Transmission", options: options.transmissions, value: transmission, onSelect: setTransPick };
      case "model": return { title: "Model", options: options.models, value: model, onSelect: setModelPick };
      case "derivative": return { title: "Derivative", options: options.derivatives, value: derivative, onSelect: setDerivative };
      case "year_registered": {
        const yrs: number[] = [];
        const now = new Date().getFullYear();
        const start = yearOfProduction ?? (now - 10);
        for (let y = start; y <= now + 1; y++) yrs.push(y);
        return { title: "Year Registered", options: yrs, value: yearRegistered, onSelect: setYearRegistered };
      }
      case "colour": return { title: "Colour", options: COLOURS, value: colour, onSelect: setColour };
      case "windscreen_condition": return { title: "Windscreen", options: [...WINDSCREEN_OPTIONS], value: windscreen, onSelect: (v: any) => setWindscreen(v) };
      case "service_history": return { title: "Service History", options: [...SERVICE_HISTORY], value: serviceHistory, onSelect: (v: any) => setServiceHistory(v) };
      default: return { title: "", options: [], value: null, onSelect: () => {} };
    }
  };

  const wheelProps = wheelOptionsFor();
  const scannedIdentity = !!(licenseDiskInfo?.vin || licenseDiskInfo?.colour);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}><Ionicons name="chevron-back" size={22} color={colors.text} /></TouchableOpacity>
          <Text style={styles.headerTitle}>SUBMIT VEHICLE</Text>
          <View style={{ width: 22 }} />
        </View>

        <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: tabBarHeight + 40 }]} keyboardShouldPersistTaps="handled">
          <Text style={styles.sectionTitle}>VEHICLE SPECIFICATION</Text>
          <Field label="Make" value={make} onPress={() => openWheel("make")} testID="pick-make" />
          <Field label="Fuel Type" value={fuelType} onPress={() => make ? openWheel("fuel_type") : setError("Choose Make first")} testID="pick-fuel" />
          <Field label="Year of Production" value={yearOfProduction?.toString() ?? null} onPress={() => fuelType ? openWheel("year_of_production") : setError("Choose Fuel first")} testID="pick-yop" />
          <Field label="Transmission" value={transmission} onPress={() => yearOfProduction ? openWheel("transmission") : setError("Choose Year first")} testID="pick-trans" />
          <Field label="Model" value={model} onPress={() => transmission ? openWheel("model") : setError("Choose Transmission first")} testID="pick-model" />
          <Field label="Derivative" value={derivative} onPress={() => model ? openWheel("derivative") : setError("Choose Model first")} testID="pick-deriv" />
          <Field label="Year Registered" value={yearRegistered?.toString() ?? null} onPress={() => openWheel("year_registered")} testID="pick-yr-reg" />

          <Text style={styles.sectionTitle}>IDENTITY</Text>
          <TouchableOpacity testID="scan-license-disk-button" style={styles.scanBtn} onPress={() => router.push({ pathname: "/(app)/scan", params: { returnPath: "submit" } } as any)}>
            <Ionicons name="barcode-outline" size={22} color={colors.text} />
            <View style={{ flex: 1 }}>
              <Text style={styles.scanText}>{licenseDisk ? (scannedIdentity ? "License Disc Decoded" : "Scanned") : "Scan License Disc (optional)"}</Text>
              {licenseDisk && <Text style={styles.scanHint}>Tap to re-scan</Text>}
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
          {scannedIdentity && licenseDiskInfo ? (
            <View style={styles.diskInfo}>
              {licenseDiskInfo.vin ? <Text style={styles.diskLine}>VIN: <Text style={styles.diskMono}>{licenseDiskInfo.vin}</Text></Text> : null}
              {licenseDiskInfo.engineNo ? <Text style={styles.diskLine}>Engine: <Text style={styles.diskMono}>{licenseDiskInfo.engineNo}</Text></Text> : null}
              {licenseDiskInfo.colour ? <Text style={styles.diskLine}>Colour: <Text style={styles.diskMono}>{licenseDiskInfo.colour}</Text></Text> : null}
            </View>
          ) : (
            <>
              <Field label="Colour" value={colour} hint="Choose colour" onPress={() => openWheel("colour")} testID="pick-colour" />
              <View style={styles.tbcRow}>
                <Text style={styles.tbcLabel}>VIN & Engine will default to <Text style={styles.tbcHl}>TBC</Text> until scanned.</Text>
              </View>
            </>
          )}

          <Text style={styles.sectionTitle}>CONDITION</Text>
          <Text style={styles.ratingLabel}>Exterior · {exteriorRating}/10</Text>
          <RatingDots value={exteriorRating} onChange={setExteriorRating} />
          <Text style={styles.ratingLabel}>Interior · {interiorRating}/10</Text>
          <RatingDots value={interiorRating} onChange={setInteriorRating} />
          <Text style={styles.ratingLabel}>Tyres · {tyreRating}/10</Text>
          <RatingDots value={tyreRating} onChange={setTyreRating} />
          <Field label="Windscreen" value={windscreen} onPress={() => openWheel("windscreen_condition")} testID="pick-windscreen" />

          <Text style={styles.sectionTitle}>SERVICE HISTORY</Text>
          <Field label="Service History" value={serviceHistory} onPress={() => openWheel("service_history")} testID="pick-service" />
          <View style={styles.row2}>
            <View style={{ flex: 1 }}>
              <Text style={styles.subLabel}>LAST SERVICE DATE</Text>
              <TextInput style={styles.input} value={lastServiceDate} onChangeText={setLastServiceDate} placeholder="YYYY-MM-DD (TBC)" placeholderTextColor={colors.textDisabled} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.subLabel}>LAST SERVICE MILEAGE</Text>
              <TextInput style={styles.input} value={lastServiceMileage} onChangeText={setLastServiceMileage} placeholder="TBC" placeholderTextColor={colors.textDisabled} keyboardType="numeric" />
            </View>
          </View>

          <Text style={styles.sectionTitle}>ODOMETER</Text>
          <TextInput testID="mileage-input" style={styles.input} value={mileage} onChangeText={setMileage} placeholder="Current mileage (km)" placeholderTextColor={colors.textDisabled} keyboardType="numeric" />

          <Text style={styles.sectionTitle}>PHOTOS</Text>
          <View style={styles.photoGrid}>
            {PHOTO_ORDER.map((p) => (
              <TouchableOpacity key={p.key} style={styles.photoBox} onPress={() => pickPhoto(p.key)} testID={`photo-${p.key}`}>
                {photos[p.key] ? (
                  <Image source={{ uri: photos[p.key] }} style={styles.photo} />
                ) : (
                  <View style={styles.photoEmpty}>
                    <Ionicons name="camera-outline" size={20} color={colors.textSecondary} />
                  </View>
                )}
                <Text style={styles.photoLabel} numberOfLines={1}>{p.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.sectionTitle}>DAMAGE</Text>
          <TouchableOpacity style={styles.checkRow} onPress={() => setPaintEvidence((v) => !v)} testID="toggle-paint">
            <View style={[styles.checkbox, paintEvidence && styles.checkboxOn]}>{paintEvidence ? <Ionicons name="checkmark" size={14} color="#000" /> : null}</View>
            <Text style={styles.checkText}>Evidence of paint work</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.checkRow} onPress={() => setAccidentDamage((v) => !v)} testID="toggle-accident">
            <View style={[styles.checkbox, accidentDamage && styles.checkboxOn]}>{accidentDamage ? <Ionicons name="checkmark" size={14} color="#000" /> : null}</View>
            <Text style={styles.checkText}>Evidence of accident damage</Text>
          </TouchableOpacity>

          <Text style={styles.sectionTitle}>RECONDITIONING COSTS</Text>
          <Text style={styles.sectionHint}>Itemise what you would need to spend to get this car to showroom condition.</Text>
          {reconItems.map((item, i) => (
            <View key={i} style={styles.reconRow}>
              <TextInput style={[styles.input, { flex: 2 }]} value={item.label} onChangeText={(v) => updateReconItem(i, { label: v })} placeholder="e.g. Paint front bumper" placeholderTextColor={colors.textDisabled} />
              <TextInput style={[styles.input, { flex: 1 }]} value={item.amount} onChangeText={(v) => updateReconItem(i, { amount: v })} placeholder="R" placeholderTextColor={colors.textDisabled} keyboardType="numeric" />
              <TouchableOpacity style={styles.reconRemove} onPress={() => removeReconItem(i)}><Ionicons name="close" size={16} color={colors.danger} /></TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity style={styles.reconAdd} onPress={addReconItem} testID="add-recon">
            <Ionicons name="add" size={16} color={colors.text} />
            <Text style={styles.reconAddText}>ADD LINE ITEM</Text>
          </TouchableOpacity>
          {reconTotal > 0 ? <Text style={styles.reconTotal}>Total reconditioning: R {reconTotal.toFixed(2)}</Text> : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <TouchableOpacity style={[styles.submitBtn, submitting && styles.submitBtnDisabled]} onPress={handleSubmit} disabled={submitting} testID="submit-button">
            {submitting ? <ActivityIndicator color="#000" /> : (<><Ionicons name="paper-plane" size={18} color="#000" /><Text style={styles.submitBtnText}>Submit for Pricing</Text></>)}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>

      <WheelPicker
        visible={wheelField != null}
        title={wheelProps.title}
        options={wheelProps.options}
        value={wheelProps.value}
        onSelect={wheelProps.onSelect}
        onClose={() => setWheelField(null)}
        formatter={wheelProps.formatter}
        testID={`wheel-${wheelField ?? "none"}`}
      />

      {/* Billing confirmation */}
      <Modal visible={billingConfirmOpen} transparent animationType="fade" onRequestClose={() => setBillingConfirmOpen(false)}>
        <View style={styles.billBackdrop}>
          <View style={styles.billCard} testID="billing-confirm-modal">
            <View style={styles.billHeader}>
              <Ionicons name="cash-outline" size={22} color={colors.text} />
              <Text style={styles.billTitle}>CONFIRM SUBMISSION</Text>
            </View>
            <View style={{ padding: spacing.md }}>
              <View style={styles.billFeeBox}>
                <Text style={styles.billFeeAmount}>R50.00</Text>
                <Text style={styles.billFeeCaption}>per priced submission · incl. VAT</Text>
              </View>
              <Text style={styles.billNote}>No fee if Fourbuy does not return a price within 24 hours.</Text>
              <TouchableOpacity testID="billing-confirm-check" style={styles.billCheckRow} onPress={() => setBillingAckChecked((v) => !v)}>
                <View style={[styles.checkbox, billingAckChecked && styles.checkboxOn]}>{billingAckChecked ? <Ionicons name="checkmark" size={14} color="#000" /> : null}</View>
                <Text style={styles.checkText}>I agree to the R50 fee for this submission.</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.billFooter}>
              <TouchableOpacity style={styles.billCancel} onPress={() => { setBillingConfirmOpen(false); setBillingAckChecked(false); }} testID="billing-confirm-cancel"><Text style={styles.billCancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.billOk, !billingAckChecked && { opacity: 0.4 }]} disabled={!billingAckChecked} onPress={() => { setBillingAckChecked(false); performSubmit(); }} testID="billing-confirm-submit">
                <Ionicons name="paper-plane" size={16} color="#000" />
                <Text style={styles.billOkText}>Confirm & Submit</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.paper },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 2, textTransform: "uppercase" },
  scroll: { padding: spacing.md, gap: spacing.sm },
  sectionTitle: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 2, marginTop: spacing.md, marginBottom: 4, textTransform: "uppercase" },
  sectionHint: { color: colors.textSecondary, fontSize: 12, marginBottom: spacing.sm, fontStyle: "italic" },

  field: { flexDirection: "row", alignItems: "center", backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, marginBottom: 8 },
  fieldLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginBottom: 3 },
  fieldValue: { color: colors.text, fontSize: 15, fontWeight: "700" },
  fieldValuePlaceholder: { color: colors.textDisabled, fontWeight: "500" },

  scanBtn: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, marginBottom: 8 },
  scanText: { color: colors.text, fontSize: 14, fontWeight: "700" },
  scanHint: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  diskInfo: { backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radius.sm, padding: spacing.sm, marginBottom: spacing.sm, gap: 4 },
  diskLine: { color: colors.text, fontSize: 12 },
  diskMono: { fontFamily: fonts.mono, color: colors.text, fontWeight: "700" },
  tbcRow: { padding: 10, backgroundColor: colors.paper, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderLight, marginTop: 4 },
  tbcLabel: { color: colors.textSecondary, fontSize: 11 },
  tbcHl: { color: colors.text, fontWeight: "800" },

  ratingLabel: { color: colors.text, fontSize: 13, fontWeight: "700", marginTop: 6 },
  dotsRow: { flexDirection: "row", gap: 4, marginTop: 6, marginBottom: 4 },
  dot: { flex: 1, height: 30, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.card },
  dotActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  dotText: { color: colors.textSecondary, fontSize: 11, fontWeight: "700" },
  dotTextActive: { color: "#000", fontWeight: "800" },

  row2: { flexDirection: "row", gap: spacing.sm },
  subLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 1.2, marginBottom: 4 },
  input: { backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontSize: 14 },

  photoGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  photoBox: { width: "31.5%", aspectRatio: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, overflow: "hidden", backgroundColor: colors.card, alignItems: "center", justifyContent: "flex-end" },
  photo: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, width: "100%", height: "100%" },
  photoEmpty: { flex: 1, alignItems: "center", justifyContent: "center", alignSelf: "stretch" },
  photoLabel: { position: "absolute", bottom: 0, width: "100%", textAlign: "center", color: "#fff", fontSize: 10, backgroundColor: "rgba(0,0,0,0.6)", paddingVertical: 3, fontWeight: "700", letterSpacing: 0.5 },

  checkRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.card, marginTop: 6 },
  checkbox: { width: 22, height: 22, borderRadius: 4, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkText: { color: colors.text, fontSize: 13, flex: 1 },

  reconRow: { flexDirection: "row", gap: 6, alignItems: "center", marginBottom: 6 },
  reconRemove: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.danger + "55", backgroundColor: colors.danger + "12", borderRadius: radius.sm },
  reconAdd: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: 10, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, borderRadius: radius.sm, marginTop: 4 },
  reconAddText: { color: colors.text, fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  reconTotal: { color: colors.text, fontSize: 13, fontWeight: "800", marginTop: 6, textAlign: "right" },

  error: { color: colors.danger, fontSize: 13, marginTop: spacing.sm, textAlign: "center" },
  submitBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: spacing.lg, paddingVertical: 14, backgroundColor: colors.primary, borderRadius: radius.md },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { color: "#000", fontWeight: "800", fontSize: 15, letterSpacing: 1.5, textTransform: "uppercase" },

  billBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "center", alignItems: "center", padding: spacing.lg },
  billCard: { width: "100%", maxWidth: 440, backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderLight, overflow: "hidden" },
  billHeader: { flexDirection: "row", alignItems: "center", gap: 10, padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.paper },
  billTitle: { color: colors.text, fontSize: 15, fontWeight: "800", letterSpacing: 2 },
  billFeeBox: { alignItems: "center", padding: spacing.md, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radius.md, backgroundColor: colors.paper, marginBottom: spacing.md },
  billFeeAmount: { color: colors.text, fontSize: 32, fontWeight: "800", letterSpacing: 1 },
  billFeeCaption: { color: colors.textSecondary, fontSize: 11, marginTop: 4, letterSpacing: 0.5 },
  billNote: { color: colors.text, fontSize: 12, textAlign: "center", marginBottom: spacing.md },
  billCheckRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.paper },
  billFooter: { flexDirection: "row", gap: spacing.sm, padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.paper },
  billCancel: { flex: 1, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: "center", backgroundColor: colors.card },
  billCancelText: { color: colors.textSecondary, fontWeight: "700" },
  billOk: { flex: 2, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, borderRadius: radius.md, backgroundColor: colors.primary },
  billOkText: { color: "#000", fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
});
