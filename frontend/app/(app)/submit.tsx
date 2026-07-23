import { useCallback, useEffect, useMemo, useState } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, TextInput, Image, ActivityIndicator, KeyboardAvoidingView, Platform, Alert, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { storage } from "@/src/utils/storage";
import { SCAN_BUFFER_KEY, SCAN_PARSED_KEY } from "./scan";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";
import WheelPicker from "@/src/components/WheelPicker";
import MonthYearPicker, { formatIsoMonthYear } from "@/src/components/MonthYearPicker";
import { decodeLicenseDisk, LicenseDiskInfo } from "@/src/utils/licenseDisk";

type PhotoKey = "front" | "driver_side" | "passenger_side" | "rear" | "interior";
const PHOTO_ORDER: { key: PhotoKey; label: string }[] = [
  { key: "front", label: "Front" },
  { key: "driver_side", label: "Driver's Side" },
  { key: "passenger_side", label: "Passenger Side" },
  { key: "rear", label: "Rear" },
  { key: "interior", label: "Interior" },
];

const WINDSCREEN_OPTIONS = ["Perfect", "Chip Repairs", "Needs Replacement"] as const;
type Windscreen = typeof WINDSCREEN_OPTIONS[number];
const SERVICE_HISTORY = [
  "Full Service History with Agents",
  "Full Service History with Agents & Non-Agents",
  "Partial Service History",
  "No Service History",
] as const;
type ServiceHistory = typeof SERVICE_HISTORY[number];
const COLOURS = ["White", "Black", "Silver", "Grey", "Blue", "Red", "Green", "Yellow", "Orange", "Brown", "Beige", "Gold", "Maroon"];

const PAINT_QUALITY_OPTIONS = ["Excellent", "Fair", "Poor"] as const;
type PaintQuality = typeof PAINT_QUALITY_OPTIONS[number];

const ACCIDENT_DAMAGE_OPTIONS = [
  "Cosmetic",
  "Structural",
  "Mechanical",
  "Glass",
  "Electrical / Functional",
] as const;
type AccidentDamageType = typeof ACCIDENT_DAMAGE_OPTIONS[number];

// Colour-code a 1-10 condition rating: 1-3 red, 4-6 yellow, 7-10 green.
// Kept muted so it plays well with the strict monochrome theme.
const ratingColor = (n: number | null, colors: Palette): string => {
  if (n == null || n <= 0) return colors.border;
  if (n <= 3) return "#C0392B"; // red
  if (n <= 6) return "#D4AC0D"; // yellow
  return "#27AE60"; // green
};
const ratingLabelFor = (n: number | null): string => {
  if (n == null || n <= 0) return "Not rated";
  if (n <= 3) return "Poor";
  if (n <= 6) return "Fair";
  return "Good";
};

type WheelField =
  | "make" | "fuel_type" | "year_of_production" | "transmission"
  | "model" | "derivative" | "year_registered" | "colour"
  | "windscreen_condition" | "service_history";

export default function SubmitVehicle() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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

  // The four condition pillars. Each starts unrated so the dealer must
  // consciously grade the vehicle across all four before we compute the
  // overall condition average.
  const [mechanicalRating, setMechanicalRating] = useState<number | null>(null);
  const [cosmeticRating, setCosmeticRating] = useState<number | null>(null);
  const [interiorRating, setInteriorRating] = useState<number | null>(null);
  const [historyRating, setHistoryRating] = useState<number | null>(null);
  const [windscreen, setWindscreen] = useState<Windscreen | null>(null);

  // Service
  const [serviceHistory, setServiceHistory] = useState<ServiceHistory | null>(null);
  const [lastServiceDate, setLastServiceDate] = useState<string>("");
  const [lastServiceMileage, setLastServiceMileage] = useState<string>("");
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // Photos + mileage
  const [photos, setPhotos] = useState<Record<PhotoKey, string>>({ front: "", driver_side: "", passenger_side: "", rear: "", interior: "" });
  const [mileage, setMileage] = useState<string>("");

  // Damage / paint
  const [paintEvidence, setPaintEvidence] = useState(false);
  const [paintQuality, setPaintQuality] = useState<PaintQuality | null>(null);
  const [accidentDamage, setAccidentDamage] = useState(false);
  const [accidentTypes, setAccidentTypes] = useState<AccidentDamageType[]>([]);

  // Reconditioning items — `photo` is an optional base64 data URL or a
  // Cloudinary https URL (uploaded server-side on submission).
  const [reconItems, setReconItems] = useState<{ label: string; amount: string; photo?: string }[]>([]);

  // Wheel state + option cache
  const [wheelField, setWheelField] = useState<WheelField | null>(null);
  const [options, setOptions] = useState<{ makes: string[]; fuel_types: string[]; years: number[]; transmissions: string[]; models: string[]; derivatives: string[] }>({ makes: [], fuel_types: [], years: [], transmissions: [], models: [], derivatives: [] });

  // Full manufacture-year range for the currently-selected variant. We look
  // it up once the derivative is chosen so we can flag registration years
  // that fall outside the years the variant was actually built (i.e. the
  // vehicle was registered after the model was discontinued).
  const [variantYearRange, setVariantYearRange] = useState<{ min: number; max: number } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billingConfirmOpen, setBillingConfirmOpen] = useState(false);
  const [billingAckChecked, setBillingAckChecked] = useState(false);

  // Draft tracking — if the dealer is editing a saved draft, we keep the id so
  // "Save to Drafts" upserts back into the same document.
  const params = useLocalSearchParams<{ draft?: string }>();
  const [loadedDraftId, setLoadedDraftId] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);

  /**
   * Wipe every editable field back to its initial state. Called after either
   * confirming a hard reset OR after successfully saving-as-draft (so the form
   * is fresh for the next vehicle).
   */
  const resetAll = useCallback(() => {
    setMake(null);
    setFuelType(null);
    setYearOfProduction(null);
    setTransmission(null);
    setModel(null);
    setDerivative(null);
    setYearRegistered(null);
    setLicenseDisk(null);
    setLicenseDiskInfo(null);
    setColour(null);
    setVin("TBC");
    setEngineNo("TBC");
    setMechanicalRating(null);
    setCosmeticRating(null);
    setInteriorRating(null);
    setHistoryRating(null);
    setWindscreen(null);
    setServiceHistory(null);
    setLastServiceDate("");
    setLastServiceMileage("");
    setPhotos({ front: "", driver_side: "", passenger_side: "", rear: "", interior: "" });
    setMileage("");
    setPaintEvidence(false);
    setPaintQuality(null);
    setAccidentDamage(false);
    setAccidentTypes([]);
    setReconItems([]);
    setError(null);
    setLoadedDraftId(null);
  }, []);

  /** Collect current form state into a plain object for draft persistence. */
  const collectDraftPayload = useCallback(() => ({
    make_name: make,
    fuel_type: fuelType,
    year_of_production: yearOfProduction,
    transmission,
    model_name: model,
    derivative_name: derivative,
    year_registered: yearRegistered,
    license_disk_data: licenseDisk,
    colour,
    vin,
    engine_number: engineNo,
    mechanical_condition: mechanicalRating,
    cosmetic_condition: cosmeticRating,
    interior_condition: interiorRating,
    history_condition: historyRating,
    windscreen_condition: windscreen,
    service_history: serviceHistory,
    last_service_date: lastServiceDate,
    last_service_mileage: lastServiceMileage,
    photos,
    mileage,
    paint_evidence: paintEvidence,
    paint_quality: paintQuality,
    accident_damage: accidentDamage,
    accident_damage_types: accidentTypes,
    recon_items: reconItems,
  }), [make, fuelType, yearOfProduction, transmission, model, derivative, yearRegistered, licenseDisk, colour, vin, engineNo, mechanicalRating, cosmeticRating, interiorRating, historyRating, windscreen, serviceHistory, lastServiceDate, lastServiceMileage, photos, mileage, paintEvidence, paintQuality, accidentDamage, accidentTypes, reconItems]);

  /** Restore all form fields from a saved draft payload. */
  const applyDraft = useCallback((d: any) => {
    setMake(d.make_name ?? null);
    setFuelType(d.fuel_type ?? null);
    setYearOfProduction(d.year_of_production ?? null);
    setTransmission(d.transmission ?? null);
    setModel(d.model_name ?? null);
    setDerivative(d.derivative_name ?? null);
    setYearRegistered(d.year_registered ?? null);
    setLicenseDisk(d.license_disk_data ?? null);
    setColour(d.colour ?? null);
    setVin(d.vin ?? "TBC");
    setEngineNo(d.engine_number ?? "TBC");
    setMechanicalRating(d.mechanical_condition ?? null);
    setCosmeticRating(d.cosmetic_condition ?? null);
    setInteriorRating(d.interior_condition ?? null);
    setHistoryRating(d.history_condition ?? null);
    setWindscreen(d.windscreen_condition ?? null);
    setServiceHistory(d.service_history ?? null);
    setLastServiceDate(d.last_service_date ?? "");
    setLastServiceMileage(d.last_service_mileage ?? "");
    if (d.photos && typeof d.photos === "object") {
      setPhotos({
        front: d.photos.front ?? "",
        driver_side: d.photos.driver_side ?? "",
        passenger_side: d.photos.passenger_side ?? "",
        rear: d.photos.rear ?? "",
        interior: d.photos.interior ?? "",
      });
    }
    setMileage(d.mileage ?? "");
    setPaintEvidence(!!d.paint_evidence);
    setPaintQuality(d.paint_quality ?? null);
    setAccidentDamage(!!d.accident_damage);
    setAccidentTypes(Array.isArray(d.accident_damage_types) ? d.accident_damage_types : []);
    setReconItems(Array.isArray(d.recon_items) ? d.recon_items : []);
  }, []);

  // Load draft when navigated to with ?draft=<id>. Runs once on mount / when id changes.
  useEffect(() => {
    const id = params?.draft;
    if (!id || typeof id !== "string") return;
    (async () => {
      try {
        const res = await apiFetch(`/api/drafts/${id}`);
        if (res?.draft?.data) {
          applyDraft(res.draft.data);
          setLoadedDraftId(res.draft.id);
        }
      } catch {
        Alert.alert("Draft not found", "This draft may have been deleted.");
      }
    })();
  }, [params?.draft, applyDraft]);

  /** Save the current in-progress form as a draft and then reset the form. */
  const saveAsDraft = useCallback(async () => {
    setSavingDraft(true);
    try {
      const body: any = { data: collectDraftPayload() };
      if (loadedDraftId) body.id = loadedDraftId;
      await apiFetch(`/api/drafts`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      resetAll();
      Alert.alert("Saved", "Your progress has been saved as a draft. Open it from your dashboard when you're ready to continue.");
    } catch (e: any) {
      Alert.alert("Could not save draft", e?.message || "Please try again.");
    } finally {
      setSavingDraft(false);
    }
  }, [collectDraftPayload, loadedDraftId, resetAll]);

  /** Prompt: Reset (wipe) vs Save-to-Drafts vs Cancel. */
  const handleResetPress = useCallback(() => {
    // Native Alert prompt (works on iOS/Android, and RN Web maps to window.confirm
    // for the primary action). We provide 3 options.
    Alert.alert(
      "Reset submission?",
      "Would you like to save your progress as a draft or reset the form?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save to Drafts",
          onPress: saveAsDraft,
        },
        {
          text: "Reset",
          style: "destructive",
          onPress: resetAll,
        },
      ],
    );
  }, [saveAsDraft, resetAll]);

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

  // Whenever a full make/model/derivative triple is available, fetch the
  // manufacture-year range for that variant (unfiltered by year) so we can
  // warn the user when the registration year falls outside the years the
  // variant was actually built (i.e. registered after the model was
  // discontinued).
  useEffect(() => {
    let cancelled = false;
    if (!make || !model || !derivative) {
      setVariantYearRange(null);
      return;
    }
    (async () => {
      const params = new URLSearchParams();
      params.set("make", make);
      params.set("model", model);
      params.set("derivative", derivative);
      try {
        const data = await apiFetch(`/api/vehicles/options?${params.toString()}`);
        const years: number[] = (data.years || []) as number[];
        if (!cancelled && years.length > 0) {
          setVariantYearRange({ min: Math.min(...years), max: Math.max(...years) });
        } else if (!cancelled) {
          setVariantYearRange(null);
        }
      } catch {
        if (!cancelled) setVariantYearRange(null);
      }
    })();
    return () => { cancelled = true; };
  }, [make, model, derivative]);

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
    const b64 = await promptPickImage();
    if (b64) setPhotos((p) => ({ ...p, [key]: b64 }));
  };

  /** Prompts the user to Take/Choose a photo and returns a data-URL or null. */
  const promptPickImage = (): Promise<string | null> =>
    new Promise((resolve) => {
      const done = (uri: string | null) => resolve(uri);
      Alert.alert(
        "Add photo",
        "Would you like to take a photo or choose one from your library?",
        [
          {
            text: "Take Photo",
            onPress: async () => {
              const perm = await ImagePicker.requestCameraPermissionsAsync();
              if (!perm.granted) {
                Alert.alert(
                  "Camera permission needed",
                  "Enable camera access in Settings to take photos, or choose one from your library instead.",
                );
                return done(null);
              }
              const res = await ImagePicker.launchCameraAsync({
                base64: true,
                quality: 0.5,
                allowsEditing: true,
                mediaTypes: ImagePicker.MediaTypeOptions.Images,
              });
              if (res.canceled || !res.assets?.[0]?.base64) return done(null);
              done(`data:image/jpeg;base64,${res.assets[0].base64}`);
            },
          },
          {
            text: "Choose from Library",
            onPress: async () => {
              const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
              if (!perm.granted) {
                Alert.alert(
                  "Photo library permission needed",
                  "Enable photo library access in Settings to pick an image.",
                );
                return done(null);
              }
              const res = await ImagePicker.launchImageLibraryAsync({
                base64: true,
                quality: 0.5,
                allowsEditing: true,
                mediaTypes: ImagePicker.MediaTypeOptions.Images,
              });
              if (res.canceled || !res.assets?.[0]?.base64) return done(null);
              done(`data:image/jpeg;base64,${res.assets[0].base64}`);
            },
          },
          { text: "Cancel", style: "cancel", onPress: () => done(null) },
        ],
        { cancelable: true, onDismiss: () => done(null) },
      );
    });

  const addReconItem = () => setReconItems((r) => [...r, { label: "", amount: "", photo: "" }]);
  const updateReconItem = (i: number, patch: Partial<{ label: string; amount: string; photo: string }>) => setReconItems((r) => r.map((x, ix) => (ix === i ? { ...x, ...patch } : x)));
  const removeReconItem = (i: number) => setReconItems((r) => r.filter((_, ix) => ix !== i));
  const pickReconPhoto = async (i: number) => {
    const b64 = await promptPickImage();
    if (b64) updateReconItem(i, { photo: b64 });
  };
  const reconTotal = useMemo(() => reconItems.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0), [reconItems]);

  const validate = (): string | null => {
    if (!make || !fuelType || !yearOfProduction || !transmission || !model || !derivative) return "Please complete all vehicle spec fields.";
    if (!yearRegistered) return "Please choose year registered.";
    if (variantYearRange && yearRegistered < variantYearRange.min) {
      return `Registration year cannot be earlier than ${variantYearRange.min} — the first year this variant was built.`;
    }
    if (!mileage || isNaN(parseInt(mileage))) return "Enter mileage.";
    // If no VIN from scan and no manual colour picked → force colour.
    if ((!vin || vin === "TBC") && !colour) return "Please pick a colour (or scan the license disc).";
    for (const p of PHOTO_ORDER) if (!photos[p.key]) return `Photo missing: ${p.label}`;
    // Condition ratings must be explicitly chosen — all four pillars.
    if (!mechanicalRating) return "Please rate the mechanical health.";
    if (!cosmeticRating) return "Please rate the cosmetic appearance.";
    if (!interiorRating) return "Please rate the interior condition.";
    if (!historyRating) return "Please rate the general condition.";
    if (!windscreen) return "Please choose the windscreen condition.";
    if (!serviceHistory) return "Please choose the service history.";
    if (paintEvidence && !paintQuality) return "Choose the paintwork quality (Excellent, Fair or Poor).";
    if (accidentDamage && accidentTypes.length === 0) return "Select at least one type of previous accident damage.";
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
          // Kredo manufacture range for the selected variant + whether the
          // registration year falls after the model was discontinued. Kept
          // as an explicit field so admins can see the discrepancy on the
          // pricing screen without recomputing.
          variant_manufacture_range: variantYearRange,
          registered_after_discontinued: !!(
            variantYearRange && yearRegistered && yearRegistered > variantYearRange.max
          ),
          colour: colour || (licenseDiskInfo?.colour ?? "TBC"),
          vin: vin || "TBC", engine_number: engineNo || "TBC",
          license_disk_data: licenseDisk,
          mechanical_condition: mechanicalRating,
          cosmetic_condition: cosmeticRating,
          interior_condition: interiorRating,
          history_condition: historyRating,
          windscreen_condition: windscreen,
          service_history: serviceHistory,
          last_service_date: lastServiceDate || null,
          last_service_mileage: lastServiceMileage ? parseInt(lastServiceMileage) : null,
          photos, mileage: parseInt(mileage),
          paint_evidence: paintEvidence,
          paint_quality: paintEvidence ? paintQuality : null,
          accident_damage: accidentDamage,
          accident_damage_types: accidentDamage ? accidentTypes : [],
          reconditioning_items: reconItems.filter(r => r.label.trim() && parseFloat(r.amount) > 0).map(r => ({ label: r.label.trim(), amount_zar: parseFloat(r.amount), photo: r.photo || null })),
          billing_accepted: true,
        }),
      });
      // If this submission originated from a saved draft, delete the draft now
      // that the vehicle is officially submitted to avoid clutter.
      if (loadedDraftId) {
        try {
          await apiFetch(`/api/drafts/${loadedDraftId}`, { method: "DELETE" });
        } catch {
          /* non-blocking */
        }
      }
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

  const RatingDots = ({ value, onChange }: { value: number | null; onChange: (n: number) => void }) => {
    const activeColor = ratingColor(value, colors);
    return (
      <View style={styles.dotsRow}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
          const active = value != null && n <= value;
          return (
            <TouchableOpacity
              key={n}
              style={[
                styles.dot,
                active && { backgroundColor: activeColor, borderColor: activeColor },
              ]}
              onPress={() => onChange(n)}
              testID={`rating-${n}`}
            >
              <Text style={[styles.dotText, active && styles.dotTextActive]}>{n}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  };

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
        // Registered year must be >= year of production, up to next year.
        // Kredo's flatfile only lists the years a variant was actually built,
        // so we always allow at least a couple of years after the discontinuation
        // year — vehicles are commonly registered a year or two after they roll
        // off the production line.
        const start = yearOfProduction ?? (now - 10);
        const end = now + 1;
        for (let y = start; y <= end; y++) yrs.push(y);
        return { title: "Year Registered", options: yrs, value: yearRegistered, onSelect: setYearRegistered };
      }
      case "colour": return { title: "Colour", options: COLOURS, value: colour, onSelect: setColour };
      case "windscreen_condition": return { title: "Windscreen", options: [...WINDSCREEN_OPTIONS], value: windscreen, onSelect: (v: any) => setWindscreen(v as Windscreen) };
      case "service_history": return { title: "Service History", options: [...SERVICE_HISTORY], value: serviceHistory, onSelect: (v: any) => setServiceHistory(v as ServiceHistory) };
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
          <Text style={styles.headerTitle}>
            {loadedDraftId ? "EDITING DRAFT" : "SUBMIT VEHICLE"}
          </Text>
          <TouchableOpacity
            testID="reset-submission-button"
            onPress={handleResetPress}
            disabled={savingDraft}
            style={{ padding: 6 }}
            accessibilityLabel="Reset or save draft"
          >
            {savingDraft ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : (
              <Ionicons name="refresh-outline" size={20} color={colors.text} />
            )}
          </TouchableOpacity>
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
          {(() => {
            // Show a contextual notice about registration year vs the
            // variant's actual manufacture range from Kredo.
            if (!yearRegistered || !variantYearRange) return null;
            const { min, max } = variantYearRange;
            if (yearRegistered < min) {
              return (
                <View style={styles.regNoticeErr} testID="reg-notice-before-manuf">
                  <Ionicons name="close-circle" size={14} color={colors.danger} />
                  <Text style={styles.regNoticeErrText}>
                    This variant was first manufactured in {min}. Registration in {yearRegistered} isn&apos;t possible for this model.
                  </Text>
                </View>
              );
            }
            if (yearRegistered > max) {
              return (
                <View style={styles.regNoticeWarn} testID="reg-notice-post-discontinued">
                  <Ionicons name="alert-circle" size={14} color={colors.warning} />
                  <Text style={styles.regNoticeWarnText}>
                    This variant was discontinued after {max}. Your vehicle is registered in {yearRegistered} — you can still submit, but Fourbuy will use {max} as the reference model year for valuation.
                  </Text>
                </View>
              );
            }
            return (
              <View style={styles.regNoticeOk} testID="reg-notice-ok">
                <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                <Text style={styles.regNoticeOkText}>
                  Manufactured {min}–{max}. Registration year matches.
                </Text>
              </View>
            );
          })()}

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
              {licenseDiskInfo.colour ? (
                <Text style={styles.diskLine}>
                  Colour: <Text style={styles.diskMono}>{licenseDiskInfo.colour}</Text>
                  <Text style={styles.diskHint}> · editable below</Text>
                </Text>
              ) : (
                <Text style={styles.diskLine}>
                  <Text style={styles.diskHint}>Colour not detected on disc — please pick below.</Text>
                </Text>
              )}
            </View>
          ) : null}
          {/* Colour picker is always available. If the scan decoded a colour it
              pre-fills automatically, but the dealer can still override here
              in case the disc has an outdated or unusual entry. */}
          <Field
            label="Colour"
            value={colour}
            hint={licenseDiskInfo?.colour ? "Change colour" : "Choose colour"}
            onPress={() => openWheel("colour")}
            testID="pick-colour"
          />
          {!scannedIdentity ? (
            <View style={styles.tbcRow}>
              <Text style={styles.tbcLabel}>VIN & Engine will default to <Text style={styles.tbcHl}>TBC</Text> until scanned.</Text>
            </View>
          ) : null}

          <Text style={styles.sectionTitle}>CONDITION</Text>
          <Text style={styles.sectionHint}>
            Four pillars — weighted average forms the overall condition score
            (Mechanical 30% · Cosmetic 25% · Interior 25% · General 20%).
          </Text>

          <View style={styles.ratingHeader}>
            <Text style={styles.ratingTitle}>Mechanical Health</Text>
            <View style={[styles.ratingBadge, { borderColor: ratingColor(mechanicalRating, colors) }]}>
              <Text style={[styles.ratingBadgeText, { color: ratingColor(mechanicalRating, colors) }]}>
                {mechanicalRating != null ? `${mechanicalRating}/10 · ${ratingLabelFor(mechanicalRating)}` : "Not rated"}
              </Text>
            </View>
          </View>
          <RatingDots value={mechanicalRating} onChange={setMechanicalRating} />

          <View style={styles.ratingHeader}>
            <Text style={styles.ratingTitle}>Cosmetic Appearance</Text>
            <View style={[styles.ratingBadge, { borderColor: ratingColor(cosmeticRating, colors) }]}>
              <Text style={[styles.ratingBadgeText, { color: ratingColor(cosmeticRating, colors) }]}>
                {cosmeticRating != null ? `${cosmeticRating}/10 · ${ratingLabelFor(cosmeticRating)}` : "Not rated"}
              </Text>
            </View>
          </View>
          <RatingDots value={cosmeticRating} onChange={setCosmeticRating} />

          <View style={styles.ratingHeader}>
            <Text style={styles.ratingTitle}>Interior Condition</Text>
            <View style={[styles.ratingBadge, { borderColor: ratingColor(interiorRating, colors) }]}>
              <Text style={[styles.ratingBadgeText, { color: ratingColor(interiorRating, colors) }]}>
                {interiorRating != null ? `${interiorRating}/10 · ${ratingLabelFor(interiorRating)}` : "Not rated"}
              </Text>
            </View>
          </View>
          <RatingDots value={interiorRating} onChange={setInteriorRating} />

          <View style={styles.ratingHeader}>
            <Text style={styles.ratingTitle}>General Condition</Text>
            <View style={[styles.ratingBadge, { borderColor: ratingColor(historyRating, colors) }]}>
              <Text style={[styles.ratingBadgeText, { color: ratingColor(historyRating, colors) }]}>
                {historyRating != null ? `${historyRating}/10 · ${ratingLabelFor(historyRating)}` : "Not rated"}
              </Text>
            </View>
          </View>
          <RatingDots value={historyRating} onChange={setHistoryRating} />

          <Field label="Windscreen" value={windscreen} onPress={() => openWheel("windscreen_condition")} testID="pick-windscreen" hint="Choose windscreen condition" />

          <Text style={styles.sectionTitle}>SERVICE HISTORY</Text>
          <Field label="Service History" value={serviceHistory} hint="Choose service history" onPress={() => openWheel("service_history")} testID="pick-service" />
          <View style={styles.row2}>
            <View style={{ flex: 1 }}>
              <Text style={styles.subLabel}>LAST SERVICE DATE</Text>
              <TouchableOpacity
                testID="pick-last-service-date"
                style={styles.dateBtn}
                onPress={() => setDatePickerOpen(true)}
              >
                <Ionicons name="calendar-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.dateBtnText, !lastServiceDate && styles.dateBtnPlaceholder]}>
                  {lastServiceDate ? (lastServiceDate === "TBC" ? "TBC" : formatIsoMonthYear(lastServiceDate)) : "Tap to pick"}
                </Text>
              </TouchableOpacity>
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
          <TouchableOpacity
            style={styles.checkRow}
            onPress={() => {
              setPaintEvidence((v) => {
                const next = !v;
                if (!next) setPaintQuality(null);
                return next;
              });
            }}
            testID="toggle-paint"
          >
            <View style={[styles.checkbox, paintEvidence && styles.checkboxOn]}>{paintEvidence ? <Ionicons name="checkmark" size={14} color={colors.onPrimary} /> : null}</View>
            <Text style={styles.checkText}>Evidence of paint work</Text>
          </TouchableOpacity>
          {paintEvidence ? (
            <View style={styles.subPanel}>
              <Text style={styles.subPanelLabel}>Paint repair quality</Text>
              <View style={styles.pillRow}>
                {PAINT_QUALITY_OPTIONS.map((q) => {
                  const active = paintQuality === q;
                  return (
                    <TouchableOpacity
                      key={q}
                      testID={`paint-quality-${q.toLowerCase()}`}
                      onPress={() => setPaintQuality(q)}
                      style={[styles.pill, active && styles.pillActive]}
                    >
                      <Text style={[styles.pillText, active && styles.pillTextActive]}>{q}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ) : null}

          <TouchableOpacity
            style={styles.checkRow}
            onPress={() => {
              setAccidentDamage((v) => {
                const next = !v;
                if (!next) setAccidentTypes([]);
                return next;
              });
            }}
            testID="toggle-accident"
          >
            <View style={[styles.checkbox, accidentDamage && styles.checkboxOn]}>{accidentDamage ? <Ionicons name="checkmark" size={14} color={colors.onPrimary} /> : null}</View>
            <Text style={styles.checkText}>Evidence of previous accident damage</Text>
          </TouchableOpacity>
          {accidentDamage ? (
            <View style={styles.subPanel}>
              <Text style={styles.subPanelLabel}>Damage identified · select all that apply</Text>
              {ACCIDENT_DAMAGE_OPTIONS.map((opt) => {
                const on = accidentTypes.includes(opt);
                return (
                  <TouchableOpacity
                    key={opt}
                    testID={`accident-type-${opt.split(" ")[0].toLowerCase()}`}
                    style={styles.subCheckRow}
                    onPress={() => {
                      setAccidentTypes((prev) =>
                        prev.includes(opt) ? prev.filter((x) => x !== opt) : [...prev, opt]
                      );
                    }}
                  >
                    <View style={[styles.checkbox, on && styles.checkboxOn]}>
                      {on ? <Ionicons name="checkmark" size={14} color={colors.onPrimary} /> : null}
                    </View>
                    <Text style={styles.checkText}>{opt}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}

          <Text style={styles.sectionTitle}>RECONDITIONING COSTS</Text>
          <Text style={styles.sectionHint}>Itemise what you would need to spend to get this car to showroom condition.</Text>
          {reconItems.map((item, i) => (
            <View key={i} style={styles.reconRow}>
              <TextInput style={[styles.input, { flex: 2 }]} value={item.label} onChangeText={(v) => updateReconItem(i, { label: v })} placeholder="e.g. Paint front bumper" placeholderTextColor={colors.textDisabled} />
              <TextInput style={[styles.input, { flex: 1 }]} value={item.amount} onChangeText={(v) => updateReconItem(i, { amount: v })} placeholder="R" placeholderTextColor={colors.textDisabled} keyboardType="numeric" />
              {item.photo ? (
                <TouchableOpacity
                  style={styles.reconPhotoThumbWrap}
                  onPress={() => updateReconItem(i, { photo: "" })}
                  testID={`recon-photo-${i}`}
                >
                  <Image source={{ uri: item.photo }} style={styles.reconPhotoThumb} />
                  <View style={styles.reconPhotoBadge}>
                    <Ionicons name="close" size={10} color="#fff" />
                  </View>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={styles.reconPhotoBtn}
                  onPress={() => pickReconPhoto(i)}
                  testID={`recon-photo-${i}`}
                >
                  <Ionicons name="camera-outline" size={16} color={colors.text} />
                </TouchableOpacity>
              )}
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
            {submitting ? <ActivityIndicator color={colors.onPrimary} /> : (<><Ionicons name="paper-plane" size={18} color={colors.onPrimary} /><Text style={styles.submitBtnText}>Submit for Pricing</Text></>)}
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

      <MonthYearPicker
        visible={datePickerOpen}
        value={lastServiceDate || null}
        onSelect={(iso) => setLastServiceDate(iso)}
        onClose={() => setDatePickerOpen(false)}
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
                <View style={[styles.checkbox, billingAckChecked && styles.checkboxOn]}>{billingAckChecked ? <Ionicons name="checkmark" size={14} color={colors.onPrimary} /> : null}</View>
                <Text style={styles.checkText}>I agree to the R50 fee for this submission.</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.billFooter}>
              <TouchableOpacity style={styles.billCancel} onPress={() => { setBillingConfirmOpen(false); setBillingAckChecked(false); }} testID="billing-confirm-cancel"><Text style={styles.billCancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.billOk, !billingAckChecked && { opacity: 0.4 }]} disabled={!billingAckChecked} onPress={() => { setBillingAckChecked(false); performSubmit(); }} testID="billing-confirm-submit">
                <Ionicons name="paper-plane" size={16} color={colors.onPrimary} />
                <Text style={styles.billOkText}>Confirm & Submit</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.paper },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 0.3 },
  scroll: { padding: spacing.md, gap: spacing.sm },
  sectionTitle: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 2, marginTop: spacing.md, marginBottom: 4, textTransform: "uppercase" },
  regNoticeWarn: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: 6,
    marginBottom: 4,
    padding: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.paper,
  },
  regNoticeWarnText: { flex: 1, color: colors.warning, fontSize: 11, lineHeight: 16, fontWeight: "700" },
  regNoticeErr: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: 6,
    marginBottom: 4,
    padding: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.paper,
  },
  regNoticeErrText: { flex: 1, color: colors.danger, fontSize: 11, lineHeight: 16, fontWeight: "700" },
  regNoticeOk: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
    marginBottom: 4,
    padding: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
  },
  regNoticeOkText: { flex: 1, color: colors.textSecondary, fontSize: 11, lineHeight: 15 },
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
  diskHint: { color: colors.textSecondary, fontSize: 11, fontStyle: "italic" },
  tbcRow: { padding: 10, backgroundColor: colors.paper, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderLight, marginTop: 4 },
  tbcLabel: { color: colors.textSecondary, fontSize: 11 },
  tbcHl: { color: colors.text, fontWeight: "800" },

  ratingLabel: { color: colors.text, fontSize: 13, fontWeight: "700", marginTop: 6 },
  ratingHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.sm,
    marginBottom: 4,
  },
  ratingTitle: { color: colors.text, fontSize: 14, fontWeight: "700", letterSpacing: 0.2 },
  ratingBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
    backgroundColor: colors.card,
  },
  ratingBadgeText: { fontSize: 11, fontWeight: "800", letterSpacing: 0.3 },

  dotsRow: { flexDirection: "row", gap: 4, marginTop: 4, marginBottom: 4 },
  dot: { flex: 1, height: 30, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.card },
  dotActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  dotText: { color: colors.textSecondary, fontSize: 11, fontWeight: "700" },
  dotTextActive: { color: colors.onPrimary, fontWeight: "800" },

  // Sub-panels revealed when Paint/Accident checkboxes are ticked
  subPanel: {
    marginTop: 6,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    gap: 8,
  },
  subPanelLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  subCheckRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
  },

  // Paint quality pill selector
  pillRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  pill: {
    flex: 1,
    minWidth: 90,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.paper,
    alignItems: "center",
  },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { color: colors.textSecondary, fontSize: 13, fontWeight: "700", letterSpacing: 0.2 },
  pillTextActive: { color: colors.onPrimary, fontWeight: "800" },

  // Date picker trigger button (styled like a text input for consistency)
  dateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  dateBtnText: { color: colors.text, fontSize: 14, fontWeight: "700", flex: 1 },
  dateBtnPlaceholder: { color: colors.textDisabled, fontWeight: "500" },

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
  reconPhotoBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.paper, borderRadius: radius.sm },
  reconPhotoThumbWrap: { width: 30, height: 30, borderRadius: radius.sm, overflow: "hidden", borderWidth: 1, borderColor: colors.border, position: "relative" },
  reconPhotoThumb: { width: "100%", height: "100%" },
  reconPhotoBadge: { position: "absolute", top: -2, right: -2, backgroundColor: colors.danger, width: 14, height: 14, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  reconAdd: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: 10, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, borderRadius: radius.sm, marginTop: 4 },
  reconAddText: { color: colors.text, fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  reconTotal: { color: colors.text, fontSize: 13, fontWeight: "800", marginTop: 6, textAlign: "right" },

  error: { color: colors.danger, fontSize: 13, marginTop: spacing.sm, textAlign: "center" },
  submitBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: spacing.lg, paddingVertical: 14, backgroundColor: colors.primary, borderRadius: radius.md },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { color: colors.onPrimary, fontWeight: "800", fontSize: 15, letterSpacing: 1.5, textTransform: "uppercase" },

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
  billOkText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
});
