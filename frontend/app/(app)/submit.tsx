import { useCallback, useEffect, useMemo, useState } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, TextInput, Image, ActivityIndicator, KeyboardAvoidingView, Platform, Alert, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { storage } from "@/src/utils/storage";
import { SCAN_BUFFER_KEY, SCAN_PARSED_KEY, SCAN_PHOTO_KEY } from "./scan";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";
import WheelPicker from "@/src/components/WheelPicker";
import MonthYearPicker, { formatIsoMonthYear } from "@/src/components/MonthYearPicker";
import { formatMoneyInput } from "@/src/utils/format";
import { decodeLicenseDisk, LicenseDiskInfo } from "@/src/utils/licenseDisk";

type PhotoKey = "front" | "driver_side" | "passenger_side" | "rear" | "interior";
const PHOTO_ORDER: { key: PhotoKey; label: string }[] = [
  { key: "front", label: "Front" },
  { key: "driver_side", label: "Driver's Side" },
  { key: "passenger_side", label: "Passenger Side" },
  { key: "rear", label: "Rear" },
  { key: "interior", label: "Interior" },
];

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

// Reconditioning categories — each recon line item is tagged with one of
// these so admins/valuers can see at a glance what area of the vehicle
// needs money spent. "Windscreen" lives here (rather than as its own
// condition-rating field) because chipped/cracked screens are always a
// spend line, never just a rating.
const RECON_CATEGORIES = [
  "Bodywork",
  "Interior / Trim",
  "Mechanical",
  "Rims",
  "Tyres",
  "Valet",
  "Windscreen",
] as const;
type ReconCategory = typeof RECON_CATEGORIES[number];
// Max photos a dealer can attach per recon line item.
const MAX_RECON_PHOTOS = 5;

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
  | "service_history"
  // Each recon row's category picker uses "recon_category:<index>".
  | `recon_category:${number}`;

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
  // Base64 photo of the disc — captured during camera scan or uploaded
  // from gallery. Sent alongside the raw PDF-417 string so admins can
  // visually verify if the decode ever looks off.
  const [licenseDiskPhoto, setLicenseDiskPhoto] = useState<string | null>(null);
  const [colour, setColour] = useState<string | null>(null);
  const [vin, setVin] = useState<string>("TBC");
  const [engineNo, setEngineNo] = useState<string>("TBC");

  // "Vehicle Unseen, Subject to View & Less to Spend" toggle. When ON,
  // every physical-inspection section (condition rating, recon, service
  // history, damage) hides from the form and becomes non-required at
  // submit. The valuation is stamped loudly across the PDF and every UI.
  const [unseen, setUnseen] = useState(false);

  // The four condition pillars. Each starts unrated so the dealer must
  // consciously grade the vehicle across all four before we compute the
  // overall condition average.
  const [mechanicalRating, setMechanicalRating] = useState<number | null>(null);
  const [cosmeticRating, setCosmeticRating] = useState<number | null>(null);
  const [interiorRating, setInteriorRating] = useState<number | null>(null);
  const [historyRating, setHistoryRating] = useState<number | null>(null);

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

  // Reconditioning line items. Each is a `{category, amount, photos}` —
  // dealers pick a category from RECON_CATEGORIES, type an estimate, and
  // attach up to MAX_RECON_PHOTOS photos to show what work is needed.
  const [reconItems, setReconItems] = useState<{
    category: ReconCategory | null;
    amount: string;
    photos: string[];
  }[]>([]);

  // Factory Warranty & Maintenance Plan — dealer answers at valuation
  // stage. Independent toggles so a car can have one but not the other.
  // Values: null = not answered, "active" | "expired".
  type WarrantyStatus = "active" | "expired" | null;
  const [factoryWarrantyStatus, setFactoryWarrantyStatus] = useState<WarrantyStatus>(null);
  const [maintenancePlanStatus, setMaintenancePlanStatus] = useState<WarrantyStatus>(null);
  const [servicePlanStatus, setServicePlanStatus] = useState<WarrantyStatus>(null);

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
  // 3-option modal replacement for Alert.alert (which is single-button-only
  // on React Native Web — the multi-button variant is silently ignored).
  const [resetPromptOpen, setResetPromptOpen] = useState(false);
  // Inline drafts list rendered at the top of the Submit screen so dealers
  // can pick up where they left off without hunting through History.
  type DraftRow = { id: string; label?: string; updated_at?: string; data?: any };
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);

  /** Fetch the dealer's most recent drafts. Silent on failure. */
  const reloadDrafts = useCallback(async () => {
    setDraftsLoading(true);
    try {
      const res = await apiFetch("/api/drafts");
      setDrafts(Array.isArray(res?.drafts) ? res.drafts : []);
    } catch {
      // Silent — drafts list is a convenience, not a blocker.
    } finally {
      setDraftsLoading(false);
    }
  }, []);

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
    setFactoryWarrantyStatus(null);
    setMaintenancePlanStatus(null);
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
    factory_warranty_status: factoryWarrantyStatus,
    maintenance_plan_status: maintenancePlanStatus,
    service_plan_status: servicePlanStatus,
  }), [make, fuelType, yearOfProduction, transmission, model, derivative, yearRegistered, licenseDisk, colour, vin, engineNo, mechanicalRating, cosmeticRating, interiorRating, historyRating, serviceHistory, lastServiceDate, lastServiceMileage, photos, mileage, paintEvidence, paintQuality, accidentDamage, accidentTypes, reconItems, factoryWarrantyStatus, maintenancePlanStatus, servicePlanStatus]);

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
    setServiceHistory(d.service_history ?? null);
    setLastServiceDate(d.last_service_date ?? "");
    setLastServiceMileage(d.last_service_mileage != null ? formatMoneyInput(String(d.last_service_mileage)) : "");
    if (d.photos && typeof d.photos === "object") {
      setPhotos({
        front: d.photos.front ?? "",
        driver_side: d.photos.driver_side ?? "",
        passenger_side: d.photos.passenger_side ?? "",
        rear: d.photos.rear ?? "",
        interior: d.photos.interior ?? "",
      });
    }
    setMileage(d.mileage != null ? formatMoneyInput(String(d.mileage)) : "");
    setPaintEvidence(!!d.paint_evidence);
    setPaintQuality(d.paint_quality ?? null);
    setAccidentDamage(!!d.accident_damage);
    setAccidentTypes(Array.isArray(d.accident_damage_types) ? d.accident_damage_types : []);
    // Recon items — migrate legacy `{label, photo}` shape (single photo,
    // free-text label) into the new `{category, amount, photos[]}` shape
    // so old drafts still load without losing data.
    setReconItems(
      Array.isArray(d.recon_items)
        ? d.recon_items.map((r: any) => {
            const category = (RECON_CATEGORIES as readonly string[]).includes(r?.category)
              ? (r.category as ReconCategory)
              : null;
            const photos: string[] = Array.isArray(r?.photos)
              ? r.photos.filter((p: any) => typeof p === "string" && p)
              : [];
            // Legacy: single `photo` string → put it in photos[0].
            if (photos.length === 0 && typeof r?.photo === "string" && r.photo) {
              photos.push(r.photo);
            }
            return {
              category,
              amount: r?.amount != null ? formatMoneyInput(String(r.amount)) : "",
              photos,
            };
          })
        : [],
    );
    // Warranty / Maintenance Plan (optional on legacy drafts)
    setFactoryWarrantyStatus(
      d.factory_warranty_status === "active" || d.factory_warranty_status === "expired"
        ? d.factory_warranty_status
        : null,
    );
    setMaintenancePlanStatus(
      d.maintenance_plan_status === "active" || d.maintenance_plan_status === "expired"
        ? d.maintenance_plan_status
        : null,
    );
    setServicePlanStatus(
      d.service_plan_status === "active" || d.service_plan_status === "expired"
        ? d.service_plan_status
        : null,
    );
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

  // Load the drafts list whenever the Submit screen gains focus. This covers
  // both the first mount and any subsequent return from a nested screen.
  useFocusEffect(useCallback(() => {
    reloadDrafts();
  }, [reloadDrafts]));

  /** Load a specific draft into the form (used by the inline drafts card). */
  const openDraft = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/drafts/${id}`);
      if (res?.draft?.data) {
        applyDraft(res.draft.data);
        setLoadedDraftId(res.draft.id);
      }
    } catch {
      Alert.alert("Draft not found", "This draft may have been deleted.");
      reloadDrafts();
    }
  }, [applyDraft, reloadDrafts]);

  /** Delete a draft from the inline card (with a lightweight confirm). */
  const deleteDraft = useCallback(async (id: string) => {
    // A single-button confirm works on web; for a destructive prompt we
    // use window.confirm on web and Alert.alert on native.
    const proceed = Platform.OS === "web"
      ? (typeof window !== "undefined" ? window.confirm("Delete this draft? This cannot be undone.") : true)
      : await new Promise<boolean>((resolve) => {
          Alert.alert(
            "Delete draft?",
            "This cannot be undone.",
            [
              { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
              { text: "Delete", style: "destructive", onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          );
        });
    if (!proceed) return;
    try {
      await apiFetch(`/api/drafts/${id}`, { method: "DELETE" });
      // If the currently-loaded draft was deleted, drop the tracking id
      // so the next save creates a fresh document.
      if (loadedDraftId === id) setLoadedDraftId(null);
      reloadDrafts();
    } catch (e: any) {
      Alert.alert("Could not delete draft", e?.message || "Please try again.");
    }
  }, [loadedDraftId, reloadDrafts]);

  /** Save the current in-progress form as a draft and then reset the form. */
  const saveAsDraft = useCallback(async () => {
    setSavingDraft(true);
    setResetPromptOpen(false);
    try {
      const body: any = { data: collectDraftPayload() };
      if (loadedDraftId) body.id = loadedDraftId;
      await apiFetch(`/api/drafts`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      resetAll();
      // Refresh the inline drafts list so the new entry appears immediately.
      reloadDrafts();
      Alert.alert("Saved", "Your progress has been saved as a draft. You can pick it up from the Drafts card at the top of this screen.");
    } catch (e: any) {
      Alert.alert("Could not save draft", e?.message || "Please try again.");
    } finally {
      setSavingDraft(false);
    }
  }, [collectDraftPayload, loadedDraftId, resetAll, reloadDrafts]);

  /**
   * Prompt: Reset (wipe) vs Save-to-Drafts vs Cancel.
   *
   * Uses a custom Modal instead of Alert.alert because React Native Web's
   * Alert implementation ignores the buttons array (it only shows the
   * title/message via window.alert), making 3-option prompts non-functional
   * on the web platform. The modal renders identically on iOS, Android and
   * Web.
   */
  const handleResetPress = useCallback(() => {
    setResetPromptOpen(true);
  }, []);

  /** Confirm-reset action from the modal. */
  const confirmHardReset = useCallback(() => {
    setResetPromptOpen(false);
    resetAll();
  }, [resetAll]);

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
    // Recon-category wheel is also discrete (fixed 5-option list).
    const isDiscrete =
      field === "service_history" ||
      field === "colour" ||
      field === "year_registered" ||
      (typeof field === "string" && field.startsWith("recon_category:"));
    if (!isDiscrete) {
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
        const parsedStr = await storage.getItem<string>(SCAN_PARSED_KEY, "");
        // Either a raw PDF-417 string, OR an OCR-only parsed payload
        // (backend Gemini fallback) should trigger auto-fill.
        if (buf || parsedStr) {
          if (buf) setLicenseDisk(buf);
          let parsed: LicenseDiskInfo | null = null;
          try {
            parsed = parsedStr
              ? JSON.parse(parsedStr)
              : (buf ? decodeLicenseDisk(buf) : null);
          } catch {
            parsed = buf ? decodeLicenseDisk(buf) : null;
          }
          setLicenseDiskInfo(parsed);
          if (parsed?.colour) setColour((prev) => prev || parsed!.colour!);
          if (parsed?.vin) setVin(parsed.vin);
          if (parsed?.engineNo) setEngineNo(parsed.engineNo);
          // Also pull the licence-disc photograph if the scan flow
          // captured one (camera still-frame or gallery upload).
          const photo = await storage.getItem<string>(SCAN_PHOTO_KEY, "");
          if (photo) setLicenseDiskPhoto(photo);
          await storage.removeItem(SCAN_BUFFER_KEY);
          await storage.removeItem(SCAN_PARSED_KEY);
          await storage.removeItem(SCAN_PHOTO_KEY);
        }
      })();
    }, [])
  );

  const pickPhoto = async (key: PhotoKey) => {
    const b64 = await promptPickImage();
    if (b64) setPhotos((p) => ({ ...p, [key]: b64 }));
  };

  /** Prompts the user to Take/Choose a photo and returns a data-URL or null.
   *
   * Platform behaviour:
   *   • Native (iOS/Android): shows an action sheet with "Take Photo" /
   *     "Choose from Library" / "Cancel". Requests the appropriate
   *     permission before launching each source.
   *   • Web: skips the action sheet entirely (Alert.alert can only show
   *     an OK button in the browser) and opens the OS file picker
   *     directly via `launchImageLibraryAsync`. On mobile browsers this
   *     picker also offers "Take Photo" via the underlying <input
   *     type=file capture=environment> element, so no functionality is
   *     lost.
   */
  const promptPickImage = (): Promise<string | null> => {
    if (Platform.OS === "web") {
      // Direct-to-library on web — no permission gate needed, the
      // browser handles it.
      return (async () => {
        const res = await ImagePicker.launchImageLibraryAsync({
          base64: true,
          quality: 0.5,
          allowsEditing: false, // web crop UI is jank; skip it
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
        });
        if (res.canceled || !res.assets?.[0]?.base64) return null;
        return `data:image/jpeg;base64,${res.assets[0].base64}`;
      })();
    }
    return new Promise((resolve) => {
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
  };

  const addReconItem = () =>
    setReconItems((r) => [...r, { category: null, amount: "", photos: [] }]);
  const updateReconItem = (
    i: number,
    patch: Partial<{ category: ReconCategory | null; amount: string; photos: string[] }>,
  ) => setReconItems((r) => r.map((x, ix) => (ix === i ? { ...x, ...patch } : x)));
  const removeReconItem = (i: number) => setReconItems((r) => r.filter((_, ix) => ix !== i));
  const addReconPhoto = async (i: number) => {
    const b64 = await promptPickImage();
    if (!b64) return;
    setReconItems((r) =>
      r.map((x, ix) =>
        ix !== i
          ? x
          : { ...x, photos: [...(x.photos || []), b64].slice(0, MAX_RECON_PHOTOS) },
      ),
    );
  };
  const removeReconPhoto = (i: number, pIdx: number) =>
    setReconItems((r) =>
      r.map((x, ix) =>
        ix !== i ? x : { ...x, photos: (x.photos || []).filter((_p, px) => px !== pIdx) },
      ),
    );
  // Recon amounts are stored as user-typed strings (with commas for
  // display) — strip them before parseFloat so totals & validation are
  // correct.
  const reconTotal = useMemo(() => reconItems.reduce((s, r) => s + (parseFloat((r.amount || "").replace(/,/g, "")) || 0), 0), [reconItems]);

  const validate = (): string | null => {
    if (!make || !fuelType || !yearOfProduction || !transmission || !model || !derivative) return "Please complete all vehicle spec fields.";
    if (!yearRegistered) return "Please choose year registered.";
    if (variantYearRange && yearRegistered < variantYearRange.min) {
      return `Registration year cannot be earlier than ${variantYearRange.min} — the first year this variant was built.`;
    }
    if (!mileage || isNaN(parseInt(mileage.replace(/,/g, "")))) return "Enter mileage.";
    // If no VIN from scan and no manual colour picked → force colour.
    if ((!vin || vin === "TBC") && !colour) return "Please pick a colour (or scan the license disc).";
    for (const p of PHOTO_ORDER) if (!photos[p.key]) return `Photo missing: ${p.label}`;
    // Inspection-derived fields — skipped entirely when the dealer
    // toggled "Vehicle Unseen" (a desktop-only valuation request).
    if (!unseen) {
      // Condition ratings must be explicitly chosen — all four pillars.
      if (!mechanicalRating) return "Please rate the mechanical health.";
      if (!cosmeticRating) return "Please rate the cosmetic appearance.";
      if (!interiorRating) return "Please rate the interior condition.";
      if (!historyRating) return "Please rate the general condition.";
      if (!serviceHistory) return "Please choose the service history.";
      if (paintEvidence && !paintQuality) return "Choose the paintwork quality (Excellent, Fair or Poor).";
      if (accidentDamage && accidentTypes.length === 0) return "Select at least one type of previous accident damage.";
      // If a recon line has an amount but no category (or vice versa),
      // stop the dealer submitting so we don't lose or mis-label spend.
      for (let i = 0; i < reconItems.length; i++) {
        const r = reconItems[i];
        const amt = parseFloat((r.amount || "").replace(/,/g, ""));
        const hasAmt = !isNaN(amt) && amt > 0;
        if (r.category && !hasAmt) return `Recon line ${i + 1}: please enter an amount.`;
        if (hasAmt && !r.category) return `Recon line ${i + 1}: please choose a category.`;
      }
    }
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
          license_disk_photo: licenseDiskPhoto,
          // Desktop / unseen-vehicle mode: submits without inspection
          // fields. Backend relaxes validation and downstream renderers
          // stamp the valuation with the "Vehicle Unseen" banner.
          unseen,
          // Unseen submissions are priced *as if in perfect condition*
          // (10/10 across all four pillars), since the dealer hasn't
          // physically inspected the car and the valuation is on a
          // desktop/subject-to-view basis. Physical inspection fields
          // (service history, damage, recon) still get skipped below.
          mechanical_condition: unseen ? 10 : mechanicalRating,
          cosmetic_condition: unseen ? 10 : cosmeticRating,
          interior_condition: unseen ? 10 : interiorRating,
          history_condition: unseen ? 10 : historyRating,
          service_history: unseen ? null : serviceHistory,
          last_service_date: unseen ? null : (lastServiceDate || null),
          last_service_mileage: unseen ? null : (lastServiceMileage ? parseInt(lastServiceMileage.replace(/,/g, "")) : null),
          photos, mileage: parseInt(mileage.replace(/,/g, "")),
          paint_evidence: unseen ? null : paintEvidence,
          paint_quality: unseen ? null : (paintEvidence ? paintQuality : null),
          accident_damage: unseen ? null : accidentDamage,
          accident_damage_types: unseen ? [] : (accidentDamage ? accidentTypes : []),
          reconditioning_items: unseen
            ? []
            : reconItems
                .filter((r) => r.category && parseFloat((r.amount || "").replace(/,/g, "")) > 0)
                .map((r) => ({
                  // `category` is the new canonical tag; `label` is also
                  // set for backwards compat with existing PDF/admin views.
                  category: r.category,
                  label: r.category as string,
                  amount_zar: parseFloat((r.amount || "").replace(/,/g, "")),
                  photos: (r.photos || []).slice(0, MAX_RECON_PHOTOS),
                })),
          // Warranty & Maintenance Plan status. Unseen submissions leave
          // these unanswered so we don't record a guess for the AI.
          factory_warranty_status: unseen ? null : factoryWarrantyStatus,
          maintenance_plan_status: unseen ? null : maintenancePlanStatus,
          service_plan_status: unseen ? null : servicePlanStatus,
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
      case "service_history": return { title: "Service History", options: [...SERVICE_HISTORY], value: serviceHistory, onSelect: (v: any) => setServiceHistory(v as ServiceHistory) };
      default: {
        // Dynamic recon-category picker: "recon_category:<index>".
        if (typeof wheelField === "string" && wheelField.startsWith("recon_category:")) {
          const idx = parseInt(wheelField.split(":")[1] || "0", 10);
          return {
            title: "Recon Category",
            options: [...RECON_CATEGORIES],
            value: reconItems[idx]?.category ?? null,
            onSelect: (v: any) => updateReconItem(idx, { category: v as ReconCategory }),
          };
        }
        return { title: "", options: [], value: null, onSelect: () => {} };
      }
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
          {/* Inline drafts — dealers can resume any in-progress submission
              directly from the top of the Submit screen. Hidden when the
              user is already editing a draft (no need to switch mid-edit)
              or when the list is empty. */}
          {!loadedDraftId && drafts.length > 0 ? (
            <View style={styles.inlineDraftsCard} testID="submit-inline-drafts">
              <View style={styles.inlineDraftsHeader}>
                <View style={styles.inlineDraftsBadge}>
                  <Ionicons name="bookmark-outline" size={14} color={colors.onPrimary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inlineDraftsTitle}>PICK UP WHERE YOU LEFT OFF</Text>
                  <Text style={styles.inlineDraftsSub}>
                    {drafts.length} saved draft{drafts.length === 1 ? "" : "s"}
                  </Text>
                </View>
                {draftsLoading ? <ActivityIndicator size="small" color={colors.text} /> : null}
              </View>
              <View style={styles.inlineDraftsList}>
                {drafts.slice(0, 5).map((d) => (
                  <View key={d.id} style={styles.inlineDraftRow} testID={`inline-draft-${d.id}`}>
                    <TouchableOpacity
                      style={{ flex: 1 }}
                      onPress={() => openDraft(d.id)}
                      testID={`inline-draft-open-${d.id}`}
                    >
                      <Text style={styles.inlineDraftLabel} numberOfLines={1}>
                        {d.label || "Untitled draft"}
                      </Text>
                      <Text style={styles.inlineDraftMeta}>
                        Updated {d.updated_at ? new Date(d.updated_at).toLocaleString() : "recently"}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.inlineDraftDelete}
                      onPress={() => deleteDraft(d.id)}
                      testID={`inline-draft-delete-${d.id}`}
                      accessibilityLabel="Delete draft"
                    >
                      <Ionicons name="trash-outline" size={16} color={colors.danger} />
                    </TouchableOpacity>
                  </View>
                ))}
                {drafts.length > 5 ? (
                  <Text style={styles.inlineDraftsMore}>+ {drafts.length - 5} more in History</Text>
                ) : null}
              </View>
            </View>
          ) : null}

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

          {/* ---- Vehicle Unseen toggle ----
              Sits between the identity section and the condition rating
              so the dealer sees it BEFORE they start rating anything.
              Toggling it ON hides the condition, service-history,
              damage and reconditioning sections entirely (see the
              `{!unseen && ...}` guards below), relaxes backend
              validation, and stamps the resulting valuation with the
              "Vehicle Unseen, Subject to View & Less to Spend" banner
              across the PDF and every UI. */}
          <View style={styles.unseenBox}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.unseenTitle}>
                <Ionicons name="eye-off-outline" size={13} color={colors.textSecondary} />  Vehicle Unseen — Subject to View
              </Text>
              <Text style={styles.unseenHint}>
                Turn this on if you have NOT physically inspected the vehicle.
                Condition rating, service history, damage & reconditioning will
                be skipped. Fourbuy will price it as an unseen desktop
                valuation ({'"Less to Spend"'}).
              </Text>
            </View>
            <TouchableOpacity
              testID="unseen-toggle"
              accessibilityRole="switch"
              accessibilityState={{ checked: unseen }}
              onPress={() => setUnseen((v) => !v)}
              style={[styles.unseenSwitch, unseen && styles.unseenSwitchOn]}
            >
              <View style={[styles.unseenKnob, unseen && styles.unseenKnobOn]} />
            </TouchableOpacity>
          </View>

          {!unseen ? (
          <>
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
              <TextInput style={styles.input} value={lastServiceMileage} onChangeText={(t) => setLastServiceMileage(formatMoneyInput(t))} placeholder="TBC" placeholderTextColor={colors.textDisabled} keyboardType="numeric" />
            </View>
          </View>

          {/* --- Factory Warranty, Maintenance Plan & Service Plan --- */}
          <Text style={styles.sectionTitle}>WARRANTY, MAINTENANCE &amp; SERVICE PLAN</Text>
          <Text style={styles.helpText}>
            Is the vehicle under Factory Warranty, Maintenance Plan and/or Service Plan?
          </Text>
          <View style={styles.warrantyRow}>
            <Text style={styles.warrantyLabel}>Factory Warranty</Text>
            <View style={styles.segRow}>
              {(["active", "expired"] as const).map((v) => {
                const on = factoryWarrantyStatus === v;
                return (
                  <TouchableOpacity
                    key={v}
                    testID={`fw-${v}`}
                    style={[styles.segBtn, on && (v === "active" ? styles.segBtnOnActive : styles.segBtnOnExpired)]}
                    onPress={() => setFactoryWarrantyStatus(on ? null : v)}
                  >
                    <Ionicons
                      name={v === "active" ? "shield-checkmark" : "close-circle"}
                      size={14}
                      color={on ? "#fff" : colors.textSecondary}
                    />
                    <Text style={[styles.segBtnText, on && styles.segBtnTextOn]}>
                      {v === "active" ? "Active" : "Expired"}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
          <View style={styles.warrantyRow}>
            <Text style={styles.warrantyLabel}>Maintenance Plan</Text>
            <View style={styles.segRow}>
              {(["active", "expired"] as const).map((v) => {
                const on = maintenancePlanStatus === v;
                return (
                  <TouchableOpacity
                    key={v}
                    testID={`mp-${v}`}
                    style={[styles.segBtn, on && (v === "active" ? styles.segBtnOnActive : styles.segBtnOnExpired)]}
                    onPress={() => setMaintenancePlanStatus(on ? null : v)}
                  >
                    <Ionicons
                      name={v === "active" ? "construct" : "close-circle"}
                      size={14}
                      color={on ? "#fff" : colors.textSecondary}
                    />
                    <Text style={[styles.segBtnText, on && styles.segBtnTextOn]}>
                      {v === "active" ? "Active" : "Expired"}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
          <View style={styles.warrantyRow}>
            <Text style={styles.warrantyLabel}>Service Plan</Text>
            <View style={styles.segRow}>
              {(["active", "expired"] as const).map((v) => {
                const on = servicePlanStatus === v;
                return (
                  <TouchableOpacity
                    key={v}
                    testID={`sp-${v}`}
                    style={[styles.segBtn, on && (v === "active" ? styles.segBtnOnActive : styles.segBtnOnExpired)]}
                    onPress={() => setServicePlanStatus(on ? null : v)}
                  >
                    <Ionicons
                      name={v === "active" ? "build" : "close-circle"}
                      size={14}
                      color={on ? "#fff" : colors.textSecondary}
                    />
                    <Text style={[styles.segBtnText, on && styles.segBtnTextOn]}>
                      {v === "active" ? "Active" : "Expired"}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
          </>
          ) : null}
          {/* --- end !unseen: CONDITION + SERVICE HISTORY --- */}

          <Text style={styles.sectionTitle}>ODOMETER</Text>
          <TextInput testID="mileage-input" style={styles.input} value={mileage} onChangeText={(t) => setMileage(formatMoneyInput(t))} placeholder="Current mileage (km)" placeholderTextColor={colors.textDisabled} keyboardType="numeric" />

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

          {!unseen ? (
          <>
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
          <Text style={styles.sectionHint}>
            Add a line per area of the vehicle that needs work. Pick a category,
            enter your estimate, and attach up to {MAX_RECON_PHOTOS} photos to
            show what needs to be done.
          </Text>
          {reconItems.map((item, i) => (
            <View key={i} style={styles.reconCard}>
              <View style={styles.reconCardHeadRow}>
                <TouchableOpacity
                  testID={`recon-category-${i}`}
                  style={[styles.input, styles.reconCategoryBtn, !item.category && styles.reconCategoryBtnEmpty]}
                  onPress={() => openWheel(`recon_category:${i}` as WheelField)}
                >
                  <Text
                    style={[styles.reconCategoryText, !item.category && styles.reconCategoryTextEmpty]}
                    numberOfLines={1}
                  >
                    {item.category || "Choose area"}
                  </Text>
                  <Ionicons name="chevron-down" size={14} color={colors.textSecondary} />
                </TouchableOpacity>
                <TextInput
                  style={[styles.input, styles.reconAmountInput]}
                  value={item.amount}
                  onChangeText={(v) => updateReconItem(i, { amount: formatMoneyInput(v) })}
                  placeholder="R"
                  placeholderTextColor={colors.textDisabled}
                  keyboardType="numeric"
                  testID={`recon-amount-${i}`}
                />
                <TouchableOpacity
                  style={styles.reconRemove}
                  onPress={() => removeReconItem(i)}
                  testID={`recon-remove-${i}`}
                >
                  <Ionicons name="close" size={16} color={colors.danger} />
                </TouchableOpacity>
              </View>

              {/* Photo strip — up to MAX_RECON_PHOTOS thumbnails, then an
                  Add button. Tapping a thumbnail removes that photo. */}
              <View style={styles.reconPhotoStrip}>
                {(item.photos || []).map((p, pIdx) => (
                  <TouchableOpacity
                    key={pIdx}
                    style={styles.reconPhotoThumbWrap}
                    onPress={() => removeReconPhoto(i, pIdx)}
                    testID={`recon-photo-${i}-${pIdx}`}
                    accessibilityLabel="Tap to remove photo"
                  >
                    <Image source={{ uri: p }} style={styles.reconPhotoThumb} />
                    <View style={styles.reconPhotoBadge}>
                      <Ionicons name="close" size={10} color="#fff" />
                    </View>
                  </TouchableOpacity>
                ))}
                {(item.photos?.length ?? 0) < MAX_RECON_PHOTOS ? (
                  <TouchableOpacity
                    style={styles.reconPhotoAddBtn}
                    onPress={() => addReconPhoto(i)}
                    testID={`recon-photo-add-${i}`}
                  >
                    <Ionicons name="camera-outline" size={18} color={colors.text} />
                    <Text style={styles.reconPhotoAddText}>
                      {(item.photos?.length ?? 0) === 0
                        ? "Add photo"
                        : `${(item.photos?.length ?? 0)}/${MAX_RECON_PHOTOS}`}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <Text style={styles.reconPhotoMaxText}>
                    Max {MAX_RECON_PHOTOS} photos
                  </Text>
                )}
              </View>
            </View>
          ))}
          <TouchableOpacity style={styles.reconAdd} onPress={addReconItem} testID="add-recon">
            <Ionicons name="add" size={16} color={colors.text} />
            <Text style={styles.reconAddText}>ADD RECON LINE</Text>
          </TouchableOpacity>
          {reconTotal > 0 ? <Text style={styles.reconTotal}>Total reconditioning: R {reconTotal.toFixed(2)}</Text> : null}
          </>
          ) : null}
          {/* --- end !unseen: DAMAGE + RECONDITIONING --- */}

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
      {/* Reset / Save-to-Drafts prompt — replaces Alert.alert so it renders
          on iOS, Android AND React Native Web (which ignores Alert buttons). */}
      <Modal
        visible={resetPromptOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setResetPromptOpen(false)}
      >
        <View style={styles.resetBackdrop}>
          <View style={styles.resetCard} testID="reset-prompt-modal">
            <View style={styles.resetHeader}>
              <Ionicons name="refresh-circle-outline" size={22} color={colors.text} />
              <Text style={styles.resetTitle}>RESET SUBMISSION?</Text>
            </View>
            <View style={{ padding: spacing.md }}>
              <Text style={styles.resetBody}>
                Would you like to save your progress as a draft so you can come back to it later, or discard everything and start again?
              </Text>
            </View>
            <View style={styles.resetFooter}>
              <TouchableOpacity
                style={styles.resetCancel}
                onPress={() => setResetPromptOpen(false)}
                testID="reset-prompt-cancel"
              >
                <Text style={styles.resetCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.resetDiscard}
                onPress={confirmHardReset}
                testID="reset-prompt-discard"
              >
                <Ionicons name="trash-outline" size={14} color={colors.danger} />
                <Text style={styles.resetDiscardText}>Discard</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.resetSave}
                onPress={saveAsDraft}
                disabled={savingDraft}
                testID="reset-prompt-save-draft"
              >
                {savingDraft ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Ionicons name="bookmark-outline" size={14} color={colors.onPrimary} />
                )}
                <Text style={styles.resetSaveText}>Save Draft</Text>
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
  // ----- Vehicle Unseen toggle -----
  unseenBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.sm + 2,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    opacity: 0.92,
  },
  unseenTitle: {
    ...fonts.small,
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  unseenHint: {
    ...fonts.small,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 15,
    opacity: 0.85,
  },
  unseenSwitch: {
    width: 42,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.borderLight,
    justifyContent: "center",
    padding: 2,
  },
  unseenSwitchOn: {
    backgroundColor: colors.primary,
  },
  unseenKnob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#fff",
    alignSelf: "flex-start",
  },
  unseenKnobOn: {
    alignSelf: "flex-end",
  },
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

  // Warranty & Maintenance Plan pickers
  helpText: { color: colors.textSecondary, fontSize: 13, marginBottom: 8 },
  warrantyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  warrantyLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
    flex: 1,
    minWidth: 140,
  },
  segRow: {
    flexDirection: "row",
    gap: 6,
  },
  segBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    minWidth: 92,
    justifyContent: "center",
  },
  segBtnOnActive: {
    backgroundColor: "#22C55E",
    borderColor: "#22C55E",
    shadowColor: "#22C55E",
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  segBtnOnExpired: {
    backgroundColor: "#EF4444",
    borderColor: "#EF4444",
    shadowColor: "#EF4444",
    shadowOpacity: 0.30,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  segBtnText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "700",
  },
  segBtnTextOn: {
    color: "#fff",
  },

  reconRow: { flexDirection: "row", gap: 6, alignItems: "center", marginBottom: 6 },
  // New card-style recon item container (one per line).
  reconCard: {
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  reconCardHeadRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  reconCategoryBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  reconCategoryBtnEmpty: {
    borderStyle: "dashed",
  },
  reconCategoryText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
    flex: 1,
  },
  reconCategoryTextEmpty: {
    color: colors.textDisabled,
    fontWeight: "500",
  },
  reconAmountInput: {
    flex: 1,
    minHeight: 44,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  reconPhotoStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  reconPhotoAddBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    borderRadius: radius.sm,
    minHeight: 46,
  },
  reconPhotoAddText: {
    color: colors.text,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  reconPhotoMaxText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontStyle: "italic",
    alignSelf: "center",
  },
  reconRemove: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.danger + "55", backgroundColor: colors.danger + "12", borderRadius: radius.sm },
  reconPhotoBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.paper, borderRadius: radius.sm },
  reconPhotoThumbWrap: { width: 46, height: 46, borderRadius: radius.sm, overflow: "hidden", borderWidth: 1, borderColor: colors.border, position: "relative" },
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

  // Inline drafts card at the top of the Submit screen
  inlineDraftsCard: {
    marginBottom: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  inlineDraftsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.paper,
  },
  inlineDraftsBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  inlineDraftsTitle: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.5,
  },
  inlineDraftsSub: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  inlineDraftsList: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  inlineDraftRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  inlineDraftLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  inlineDraftMeta: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  inlineDraftDelete: {
    padding: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  inlineDraftsMore: {
    color: colors.textSecondary,
    fontSize: 11,
    textAlign: "center",
    paddingVertical: 8,
  },

  // Reset / Save-to-Drafts modal (custom because Alert.alert multi-button
  // is not supported on React Native Web).
  resetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  resetCard: {
    width: "100%",
    maxWidth: 440,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    overflow: "hidden",
  },
  resetHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.paper,
  },
  resetTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 2,
  },
  resetBody: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 20,
  },
  resetFooter: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.paper,
    flexWrap: "wrap",
  },
  resetCancel: {
    flex: 1,
    minWidth: 90,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    backgroundColor: colors.card,
  },
  resetCancelText: {
    color: colors.textSecondary,
    fontWeight: "700",
  },
  resetDiscard: {
    flex: 1,
    minWidth: 90,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.card,
  },
  resetDiscardText: {
    color: colors.danger,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
    fontSize: 12,
  },
  resetSave: {
    flex: 1.4,
    minWidth: 110,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  resetSaveText: {
    color: colors.onPrimary,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
    fontSize: 12,
  },
});
