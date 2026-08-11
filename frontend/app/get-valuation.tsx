/**
 * PUBLIC VALUATION PORTAL — Fourbuy Car Buying Co.
 *
 * Anonymous, no-login funnel for members of the public to submit their
 * vehicle for a free valuation. Route lives at `/get-valuation`. Uses the
 * SAME theme/palette and the SAME cascading make/model wheel-pickers as
 * the dealer submit flow, so the extracted vehicle data lines up exactly
 * with our seeded Kredo catalogue (essential for accurate pricing).
 *
 * Six-step wizard:
 *   1. Seller       — name, SA phone, email, POPIA consent
 *   2. Vehicle      — Make → Fuel → Year of Production → Transmission →
 *                     Model → Derivative → Year Registered → Mileage /
 *                     Colour / VIN
 *   3. License disc — optional OCR scan / photo upload to auto-fill fields
 *   4. Condition    — overall grade, service history, accident flag
 *   5. Photos       — six mandatory slots (front / rear / L / R / interior / dash)
 *   6. Review       — summary, Cloudflare Turnstile, submit → success card
 *
 * All vehicles are treated as "subject to view" — NO recon required.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Platform,
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";

import { TouchableOpacity } from "@/src/components/HapticButtons";
import TurnstileWidget from "@/src/components/TurnstileWidget";
import WheelPicker from "@/src/components/WheelPicker";
import { decodeLicenseDisk } from "@/src/utils/licenseDisk";
import { useThemeColors, useTheme, type Palette } from "@/src/theme/ThemeContext";
import { fonts, BRAND } from "@/src/theme";
import * as ImageManipulator from "expo-image-manipulator";

// ---------------------------------------------------------------------------
// Photo compression helpers — every captured image is downscaled to a max
// long edge of 1600 px and JPEG-compressed to keep each photo well under
// the backend's 5 MB per-slot cap (iPhone stills are typically 3-6 MB raw
// as base64 which fails).
// ---------------------------------------------------------------------------
const MAX_LONG_EDGE = 1600;
const TARGET_QUALITY = 0.6;

async function compressWithNative(uri: string): Promise<string | null> {
  try {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: MAX_LONG_EDGE } }],
      { compress: TARGET_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    if (!result.base64) return null;
    return `data:image/jpeg;base64,${result.base64}`;
  } catch (e) {
    console.warn("ImageManipulator failed:", e);
    return null;
  }
}

// Web-side compression via <canvas>. Runs in the browser and returns a
// JPEG data URL. Falls back to the original data URL on error so the
// user isn't stranded.
function compressWithCanvas(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(dataUrl);
    const img = new (window as any).Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const scale = Math.min(1, MAX_LONG_EDGE / Math.max(w, h));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(dataUrl);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", TARGET_QUALITY));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// Cross-platform: takes a raw data URL (or file URI on native) and
// returns a compressed data URL that is safely under the backend cap.
async function compressPhoto(sourceUriOrDataUrl: string): Promise<string> {
  if (Platform.OS === "web") return compressWithCanvas(sourceUriOrDataUrl);
  const compressed = await compressWithNative(sourceUriOrDataUrl);
  return compressed || sourceUriOrDataUrl;
}

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || "";
const TURNSTILE_SITE_KEY = process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY || "";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Overall = "Excellent" | "Good" | "Fair" | "Poor";
type ServiceHistoryVal = "Full" | "Partial" | "None" | "Not sure";
type PhotoSlot = "front" | "rear" | "left" | "right" | "interior" | "dash";

const PHOTO_ORDER: { key: PhotoSlot; label: string; hint: string }[] = [
  { key: "front", label: "Front", hint: "Full front, straight on" },
  { key: "rear", label: "Rear", hint: "Full rear, straight on" },
  { key: "left", label: "Left side", hint: "Passenger side, full length" },
  { key: "right", label: "Right side", hint: "Driver side, full length" },
  { key: "interior", label: "Interior", hint: "Front seats + dashboard" },
  { key: "dash", label: "Odometer", hint: "Dashboard showing mileage" },
];

// Wheel picker discrete option lists — kept in sync with dealer submit.tsx.
const COLOURS = ["White", "Silver", "Grey", "Black", "Blue", "Red", "Green", "Brown", "Beige", "Yellow", "Orange", "Purple", "Gold", "Other"];

type WheelField =
  | "make" | "fuel_type" | "year_of_production" | "transmission"
  | "model" | "derivative" | "year_registered" | "colour" | null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
const isSaPhone = (v: string) => /^(\+?27|0)\d{9}$/.test(v.replace(/\s|-/g, ""));

async function pickPhoto(): Promise<string | null> {
  if (Platform.OS === "web") {
    const res = await ImagePicker.launchImageLibraryAsync({
      base64: true,
      quality: 0.9,
      allowsEditing: false,
      mediaTypes: ["images"],
    });
    if (res.canceled || !res.assets?.[0]?.base64) return null;
    const raw = `data:image/jpeg;base64,${res.assets[0].base64}`;
    return compressPhoto(raw);
  }
  return new Promise((resolve) => {
    Alert.alert(
      "Add photo",
      "Would you like to take a new photo or pick one from your library?",
      [
        {
          text: "Take photo",
          onPress: async () => {
            const perm = await ImagePicker.requestCameraPermissionsAsync();
            if (!perm.granted) return resolve(null);
            const r = await ImagePicker.launchCameraAsync({
              base64: false, quality: 1, allowsEditing: false, mediaTypes: ["images"],
            });
            if (r.canceled || !r.assets?.[0]?.uri) return resolve(null);
            resolve(await compressPhoto(r.assets[0].uri));
          },
        },
        {
          text: "Photo library",
          onPress: async () => {
            const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (!perm.granted) return resolve(null);
            const r = await ImagePicker.launchImageLibraryAsync({
              base64: false, quality: 1, allowsEditing: false, mediaTypes: ["images"],
            });
            if (r.canceled || !r.assets?.[0]?.uri) return resolve(null);
            resolve(await compressPhoto(r.assets[0].uri));
          },
        },
        { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}

const TOTAL_STEPS = 6;

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------
export default function GetValuationScreen() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const router = useRouter();
  const colors = useThemeColors();
  const { mode } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Pick the correct logo variant for the current theme so it reads
  // cleanly against the page background (dark logo on light bg, light
  // logo on dark bg).
  const brandLogo = mode === "light" ? BRAND.logoLight : BRAND.logo;
  const [step, setStep] = useState(1);

  // Seller
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);

  // Vehicle (cascading — matches dealer submit)
  const [make, setMake] = useState<string | null>(null);
  const [fuelType, setFuelType] = useState<string | null>(null);
  const [yearOfProduction, setYearOfProduction] = useState<number | null>(null);
  const [transmission, setTransmission] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [derivative, setDerivative] = useState<string | null>(null);
  const [yearRegistered, setYearRegistered] = useState<number | null>(null);

  // Extras
  const [vin, setVin] = useState("");
  const [mileage, setMileage] = useState("");
  const [colour, setColour] = useState<string | null>(null);

  // Wheel picker sheet
  const [wheelField, setWheelField] = useState<WheelField>(null);
  const [options, setOptions] = useState<{
    makes: string[]; fuel_types: string[]; years: number[]; transmissions: string[]; models: string[]; derivatives: string[];
  }>({ makes: [], fuel_types: [], years: [], transmissions: [], models: [], derivatives: [] });

  // Disc capture
  const [dateOfTest, setDateOfTest] = useState<string | null>(null);
  const [licenseDiskData, setLicenseDiskData] = useState<string | null>(null);
  const [discPhoto, setDiscPhoto] = useState<string | null>(null);

  // Condition
  const [overall, setOverall] = useState<Overall | "">("");
  const [service, setService] = useState<ServiceHistoryVal | "">("");
  const [accident, setAccident] = useState(false);
  const [damageNotes, setDamageNotes] = useState("");

  // Photos
  const [photos, setPhotos] = useState<Record<PhotoSlot, string | null>>({
    front: null, rear: null, left: null, right: null, interior: null, dash: null,
  });

  // Anti-abuse + submit
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ reference: string; message: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  // ---------- vehicle options fetch (cascading) ----------
  //
  // IMPORTANT: When the user reopens a picker to change an already-set
  // field, we must NOT include that field (or any DOWNSTREAM field) as
  // a filter — otherwise the backend returns dependent lists (e.g.
  // asking for `makes` while `make=BMW` returns BMW's models). We only
  // pass filters STRICTLY UPSTREAM of the field being opened.
  //
  // Cascade order:
  //   make → fuel_type → year_of_production → transmission → model → derivative
  //
  const fetchOptions = useCallback(async (forField?: WheelField) => {
    const order: WheelField[] = ["make", "fuel_type", "year_of_production", "transmission", "model", "derivative"];
    const currentIndex = forField ? order.indexOf(forField) : order.length;
    const params = new URLSearchParams();
    if (currentIndex > 0 && make) params.set("make", make);
    if (currentIndex > 1 && fuelType) params.set("fuel_type", fuelType);
    if (currentIndex > 2 && yearOfProduction != null) params.set("year_of_production", String(yearOfProduction));
    if (currentIndex > 3 && transmission) params.set("transmission", transmission);
    if (currentIndex > 4 && model) params.set("model", model);
    try {
      const r = await fetch(`${BACKEND_URL}/api/vehicles/options${params.toString() ? "?" + params.toString() : ""}`);
      const data = await r.json();
      setOptions({
        makes: data.makes || [],
        fuel_types: data.fuel_types || [],
        years: data.years || [],
        transmissions: data.transmissions || [],
        models: data.models || [],
        derivatives: data.derivatives || [],
      });
    } catch {
      Alert.alert("Network error", "Could not fetch vehicle options. Please try again.");
    }
  }, [make, fuelType, yearOfProduction, transmission, model]);

  const openWheel = async (field: WheelField) => {
    const isDiscrete = field === "year_registered" || field === "colour";
    if (!isDiscrete && field) {
      await fetchOptions(field);
    }
    setWheelField(field);
  };

  // Cascading resets — matches dealer flow.
  const setMakePick = (v: string) => { setMake(v); setFuelType(null); setYearOfProduction(null); setTransmission(null); setModel(null); setDerivative(null); };
  const setFuelPick = (v: string) => { setFuelType(v); setYearOfProduction(null); setTransmission(null); setModel(null); setDerivative(null); };
  const setYearPick = (v: number) => { setYearOfProduction(v); setTransmission(null); setModel(null); setDerivative(null); };
  const setTransPick = (v: string) => { setTransmission(v); setModel(null); setDerivative(null); };
  const setModelPick = (v: string) => { setModel(v); setDerivative(null); };

  const wheelPropsFor = (): { title: string; options: any[]; value: any; onSelect: (v: any) => void; formatter?: (v: any) => string } => {
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
        const start = yearOfProduction ?? (now - 25);
        const end = now + 1;
        for (let y = start; y <= end; y++) yrs.push(y);
        return { title: "Year Registered", options: yrs, value: yearRegistered, onSelect: setYearRegistered };
      }
      case "colour": return { title: "Colour", options: COLOURS, value: colour, onSelect: setColour };
      default: return { title: "", options: [], value: null, onSelect: () => {} };
    }
  };
  const wheelProps = wheelPropsFor();

  // ---------- validation ----------
  const validateStep = useCallback(
    (s: number): string | null => {
      if (s === 1) {
        if (fullName.trim().length < 2) return "Please enter your full name.";
        if (!isSaPhone(phone)) return "Please enter a valid South African mobile number (e.g. 082 123 4567).";
        if (!isEmail(email)) return "Please enter a valid email address.";
        if (!consent) return "Please accept the privacy notice to continue.";
      }
      if (s === 2) {
        if (!make) return "Please choose the vehicle make.";
        if (!fuelType) return "Please choose the fuel type.";
        if (!yearOfProduction) return "Please choose the year of production.";
        if (!transmission) return "Please choose the transmission.";
        if (!model) return "Please choose the model.";
        if (!derivative) return "Please choose the derivative.";
        if (!yearRegistered) return "Please choose the year the vehicle was registered.";
        const km = parseInt(mileage.replace(/\s|,/g, "") || "-1", 10);
        if (!(km >= 0 && km <= 2_000_000)) return "Please enter a valid mileage.";
        if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin.trim())) return "VIN must be 17 characters (no I / O / Q).";
      }
      if (s === 4) {
        if (!overall) return "Please choose an overall condition.";
        if (!service) return "Please choose a service history option.";
        if (accident && damageNotes.trim().length < 5) return "Please describe the damage briefly.";
      }
      if (s === 5) {
        for (const p of PHOTO_ORDER) {
          if (!photos[p.key]) return `Please add the ${p.label} photo.`;
          if (!String(photos[p.key]).startsWith("data:image")) return `Photo ${p.label} is invalid — please retake.`;
        }
      }
      if (s === 6) {
        if (Platform.OS === "web" && !turnstileToken) return "Please complete the anti-abuse check.";
      }
      return null;
    },
    [fullName, phone, email, consent, make, fuelType, yearOfProduction, transmission, model, derivative, yearRegistered, mileage, vin, overall, service, accident, damageNotes, photos, turnstileToken],
  );

  const goNext = () => {
    const err = validateStep(step);
    if (err) { Alert.alert("One more thing", err); return; }
    setStep((s) => Math.min(TOTAL_STEPS, s + 1));
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };
  const goBack = () => {
    setStep((s) => Math.max(1, s - 1));
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };

  // ---------- disc scan / OCR ----------
  const applyDiscParsed = (parsed: any) => {
    if (!parsed) return;
    if (parsed.vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(parsed.vin)) setVin(String(parsed.vin).toUpperCase());
    if (parsed.dateOfTest) setDateOfTest(String(parsed.dateOfTest));
    if (parsed.colour && !colour) {
      // Attempt to match against our COLOURS list; fall back to whatever the disc says.
      const disk = String(parsed.colour).trim();
      const match = COLOURS.find((c) => c.toLowerCase() === disk.toLowerCase());
      setColour(match || disk);
    }
  };

  const handleScanDisc = async () => {
    const img = await pickPhoto();
    if (!img) return;
    setDiscPhoto(img);
    try {
      const r = await fetch(`${BACKEND_URL}/api/public/license-disk/decode`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: img }),
      });
      const data = await r.json();
      if (!r.ok) {
        Alert.alert("Couldn't read the disc", data?.detail || "We couldn't decode that photo. Try a sharper, close-up shot of the whole disc — or just skip and enter details manually.");
        return;
      }
      if (data?.raw) setLicenseDiskData(data.raw);
      applyDiscParsed(data?.parsed || {});
      if (data?.raw && (!data?.parsed || !Object.keys(data.parsed).length)) {
        try { applyDiscParsed(decodeLicenseDisk(data.raw)); } catch {}
      }
      Alert.alert("Disc scanned", "We've captured your VIN and roadworthy date. Please continue and confirm the make/model on the next screen.");
    } catch (e: any) {
      Alert.alert("Network error", e?.message || "Could not reach the decoder. You can skip this step.");
    }
  };

  // ---------- photos ----------
  const addPhoto = async (slot: PhotoSlot) => {
    const img = await pickPhoto();
    if (!img) return;
    setPhotos((prev) => ({ ...prev, [slot]: img }));
  };
  const removePhoto = (slot: PhotoSlot) => setPhotos((prev) => ({ ...prev, [slot]: null }));

  // ---------- submit ----------
  const submit = async () => {
    if (submitting) return;
    const err = validateStep(6);
    if (err) { Alert.alert("One more thing", err); return; }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body = {
        seller: {
          full_name: fullName.trim(),
          phone: phone.replace(/\s|-/g, ""),
          email: email.trim(),
          consent_accepted: true,
        },
        vehicle: {
          year_of_production: yearOfProduction,
          year_registered: yearRegistered,
          year: yearRegistered,  // back-compat with the old field
          make,
          model,
          derivative,
          vin: vin.trim() ? vin.trim().toUpperCase() : undefined,
          mileage: parseInt(mileage.replace(/\s|,/g, ""), 10),
          colour: colour || undefined,
          transmission: transmission || undefined,
          fuel_type: fuelType || undefined,
          date_of_test: dateOfTest || undefined,
          license_disk_data: licenseDiskData || undefined,
        },
        condition: {
          overall,
          accident_damage: accident,
          damage_notes: accident ? damageNotes.trim() : undefined,
          service_history: service,
        },
        photos,
        turnstile_token: turnstileToken,
      };
      const r = await fetch(`${BACKEND_URL}/api/public/valuation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.detail || `Submission failed (HTTP ${r.status})`);
      setResult({ reference: data.reference, message: data.message });
    } catch (e: any) {
      setSubmitError(e?.message || "Something went wrong. Please try again.");
      // Scroll to the top of step 6 so the user sees the red error banner.
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    } finally {
      setSubmitting(false);
    }
  };

  // ---------- success ----------
  if (result) {
    return <SuccessCard colors={colors} styles={styles} brandLogo={brandLogo} reference={result.reference} message={result.message} />;
  }

  const progress = step / TOTAL_STEPS;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      {/* STATIC HEADER — pinned to the top of the viewport. On web we
          add `position: sticky` so the mobile browser's shrinking /
          growing address bar can't push the Fourbuy logo off-screen
          (which was the "logo too high, cannot be seen" bug). Outside
          the KeyboardAvoidingView so the wordmark never jumps when
          the on-screen keyboard opens. */}
      <View style={styles.header}>
        <Image
          source={brandLogo}
          style={styles.headerLogo}
          resizeMode="contain"
          accessibilityLabel="Fourbuy Car Buying Co."
        />
      </View>

      {/* STATIC PROGRESS BAR — also outside the KeyboardAvoidingView. */}
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </View>
      <View style={styles.progressLabelRow}>
        <Text style={styles.progressLabel}>Step {step} of {TOTAL_STEPS}</Text>
        <Text style={styles.progressLabel}>{Math.round(progress * 100)}%</Text>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
        <ScrollView ref={scrollRef} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {step === 1 ? (
            <StepSeller
              colors={colors} styles={styles}
              fullName={fullName} setFullName={setFullName}
              phone={phone} setPhone={setPhone}
              email={email} setEmail={setEmail}
              consent={consent} setConsent={setConsent}
            />
          ) : null}
          {step === 2 ? (
            <StepVehicle
              colors={colors} styles={styles}
              make={make} fuelType={fuelType} yearOfProduction={yearOfProduction}
              transmission={transmission} model={model} derivative={derivative}
              yearRegistered={yearRegistered}
              mileage={mileage} setMileage={setMileage}
              vin={vin} setVin={setVin}
              colour={colour}
              openWheel={openWheel}
              onReset={() => {
                setMake(null);
                setFuelType(null);
                setYearOfProduction(null);
                setTransmission(null);
                setModel(null);
                setDerivative(null);
                setYearRegistered(null);
                setColour(null);
                setVin("");
                setMileage("");
              }}
            />
          ) : null}
          {step === 3 ? (
            <StepDisc
              colors={colors} styles={styles}
              discPhoto={discPhoto}
              onScan={handleScanDisc}
              onClear={() => { setDiscPhoto(null); setLicenseDiskData(null); setDateOfTest(null); }}
              didFillFields={!!(vin || dateOfTest)}
              dateOfTest={dateOfTest}
              capturedVin={vin}
            />
          ) : null}
          {step === 4 ? (
            <StepCondition
              colors={colors} styles={styles}
              overall={overall} setOverall={setOverall}
              service={service} setService={setService}
              accident={accident} setAccident={setAccident}
              damageNotes={damageNotes} setDamageNotes={setDamageNotes}
            />
          ) : null}
          {step === 5 ? (
            <StepPhotos colors={colors} styles={styles} photos={photos} onAdd={addPhoto} onRemove={removePhoto} />
          ) : null}
          {step === 6 ? (
            <StepReview
              colors={colors} styles={styles}
              summary={{
                fullName, phone, email,
                yearOfProduction, yearRegistered,
                make, fuelType, transmission, model, derivative,
                vin, mileage, colour,
                overall, service, accident, damageNotes,
              }}
              onEditStep={(s: number) => setStep(s)}
              turnstileSiteKey={TURNSTILE_SITE_KEY}
              turnstileToken={turnstileToken}
              onVerify={setTurnstileToken}
              onExpire={() => setTurnstileToken(null)}
              submitError={submitError}
            />
          ) : null}
        </ScrollView>

        {/* Sticky footer — Back (if applicable) + Continue / Submit side-by-side */}
        <View style={styles.footer}>
          <View style={styles.footerBtnRow}>
            {step > 1 ? (
              <TouchableOpacity style={styles.backBtn} onPress={goBack} disabled={submitting}>
                <Ionicons name="chevron-back" size={18} color={colors.text} />
                <Text style={styles.backBtnText}>Back</Text>
              </TouchableOpacity>
            ) : null}
            {step < TOTAL_STEPS ? (
              <TouchableOpacity style={[styles.primaryBtn, { flex: 1 }]} onPress={goNext}>
                <Text style={styles.primaryBtnText}>Continue</Text>
                <Ionicons name="arrow-forward" size={18} color={colors.onPrimary} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.primaryBtn, { flex: 1 }, submitting && { opacity: 0.6 }]}
                onPress={submit}
                disabled={submitting}
              >
                {submitting ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <>
                    <Ionicons name="paper-plane" size={16} color={colors.onPrimary} />
                    <Text style={styles.primaryBtnText}>Get my valuation</Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>
          <Text style={styles.footerHint}>
            Free • No obligation • We{"\u2019"}ll WhatsApp and email your valuation within 24 hours
          </Text>
        </View>

        {/* Wheel picker sheet */}
        <WheelPicker
          visible={wheelField !== null}
          title={wheelProps.title}
          options={wheelProps.options}
          value={wheelProps.value}
          onSelect={(v: any) => { wheelProps.onSelect(v); setWheelField(null); }}
          onClose={() => setWheelField(null)}
          formatter={wheelProps.formatter}
          testID={`wheel-${wheelField ?? "none"}`}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Step components
// ---------------------------------------------------------------------------
function StepSeller({ colors, styles, fullName, setFullName, phone, setPhone, email, setEmail, consent, setConsent }: any) {
  return (
    <View>
      <StepTitle styles={styles} title="Your details" subtitle="We'll send your valuation to these contacts" />
      <FieldWrap styles={styles} label="Full name">
        <TextInput
          style={styles.input}
          placeholder="Firstname Lastname"
          placeholderTextColor={colors.textDisabled}
          value={fullName}
          onChangeText={setFullName}
          autoCapitalize="words"
          returnKeyType="next"
        />
      </FieldWrap>
      <FieldWrap styles={styles} label="Mobile number" hint="South African mobile only (WhatsApp)">
        <TextInput
          style={styles.input}
          placeholder="082 123 4567"
          placeholderTextColor={colors.textDisabled}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          returnKeyType="next"
          maxLength={16}
        />
      </FieldWrap>
      <FieldWrap styles={styles} label="Email address">
        <TextInput
          style={styles.input}
          placeholder="you@example.com"
          placeholderTextColor={colors.textDisabled}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          returnKeyType="done"
        />
      </FieldWrap>
      <TouchableOpacity style={styles.consentRow} onPress={() => setConsent(!consent)} activeOpacity={0.7}>
        <View style={[styles.checkbox, consent && styles.checkboxOn]}>
          {consent ? <Ionicons name="checkmark" size={14} color={colors.onPrimary} /> : null}
        </View>
        <Text style={styles.consentText}>
          I accept Fourbuy{"\u2019"}s <Text style={styles.link}>Privacy Notice</Text> and agree to be contacted by
          WhatsApp or email regarding this valuation (POPIA-compliant).
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function StepVehicle({
  colors, styles,
  make, fuelType, yearOfProduction, transmission, model, derivative, yearRegistered,
  mileage, setMileage,
  vin, setVin,
  colour,
  openWheel,
  onReset,
}: any) {
  const hasAnySelection = Boolean(
    make || fuelType || yearOfProduction || transmission || model || derivative || yearRegistered || colour || vin || mileage
  );
  return (
    <View>
      <StepTitle
        styles={styles}
        title="Your vehicle"
        subtitle="Choose exactly the variant we've catalogued — accurate specs give you the accurate offer"
      />
      {hasAnySelection ? (
        <TouchableOpacity
          style={styles.resetRow}
          onPress={() =>
            Alert.alert(
              "Reset vehicle details?",
              "This will clear everything you've picked so you can start again.",
              [
                { text: "Cancel", style: "cancel" },
                { text: "Reset", style: "destructive", onPress: onReset },
              ],
            )
          }
          activeOpacity={0.7}
        >
          <Ionicons name="refresh" size={14} color={colors.textSecondary} />
          <Text style={styles.resetText}>Start over</Text>
        </TouchableOpacity>
      ) : null}
      <PickerField styles={styles} label="Make" value={make} onPress={() => openWheel("make")} />
      <PickerField styles={styles} label="Fuel Type" value={fuelType}
        onPress={() => make ? openWheel("fuel_type") : Alert.alert("Choose Make first", "Please pick the make before the fuel type.")}
        disabled={!make} />
      <PickerField styles={styles} label="Year of Production" value={yearOfProduction?.toString() ?? null}
        onPress={() => fuelType ? openWheel("year_of_production") : Alert.alert("Choose Fuel Type first", "Please pick the fuel type before the year.")}
        disabled={!fuelType} />
      <PickerField styles={styles} label="Transmission" value={transmission}
        onPress={() => yearOfProduction ? openWheel("transmission") : Alert.alert("Choose Year first", "Please pick year of production first.")}
        disabled={!yearOfProduction} />
      <PickerField styles={styles} label="Model" value={model}
        onPress={() => transmission ? openWheel("model") : Alert.alert("Choose Transmission first", "Please pick transmission first.")}
        disabled={!transmission} />
      <PickerField styles={styles} label="Derivative" value={derivative}
        onPress={() => model ? openWheel("derivative") : Alert.alert("Choose Model first", "Please pick model first.")}
        disabled={!model} />
      <PickerField styles={styles} label="Year Registered" value={yearRegistered?.toString() ?? null}
        onPress={() => openWheel("year_registered")} />
      <FieldWrap styles={styles} label="Current mileage (km)" hint="Read the odometer">
        <TextInput
          style={styles.input}
          placeholder="85 000"
          placeholderTextColor={colors.textDisabled}
          value={mileage}
          onChangeText={(t: string) => setMileage(t.replace(/[^\d\s]/g, ""))}
          keyboardType="number-pad"
          maxLength={9}
        />
      </FieldWrap>
      <PickerField styles={styles} label="Colour (optional)" value={colour}
        onPress={() => openWheel("colour")} />
      <FieldWrap styles={styles} label="VIN (optional but recommended)" hint="17 characters, e.g. WBA22CA0609U91380">
        <TextInput
          style={styles.input}
          placeholder="WBA22CA0609U91380"
          placeholderTextColor={colors.textDisabled}
          value={vin}
          onChangeText={(t: string) => setVin(t.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17))}
          autoCapitalize="characters"
          maxLength={17}
        />
      </FieldWrap>
    </View>
  );
}

function StepDisc({ colors, styles, discPhoto, onScan, onClear, didFillFields, dateOfTest, capturedVin }: any) {
  return (
    <View>
      <StepTitle
        styles={styles}
        title="License disc (optional)"
        subtitle="Snap or upload your license disc — we'll capture your VIN and roadworthy status"
      />
      <View style={styles.discCard}>
        {discPhoto ? (
          <>
            <Image source={{ uri: discPhoto }} style={styles.discImage} resizeMode="cover" />
            <View style={styles.discResults}>
              {didFillFields ? (
                <Text style={styles.discOk}>
                  <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                  {"  Captured. Continue to review."}
                </Text>
              ) : (
                <Text style={styles.discWarn}>
                  We saved a photo of your disc but couldn{"\u2019"}t auto-fill any details — that{"\u2019"}s OK, you already entered them.
                </Text>
              )}
              {capturedVin ? (
                <Text style={styles.discMuted}>VIN: {capturedVin}</Text>
              ) : null}
              {dateOfTest ? (
                <Text style={styles.discMuted}>Last roadworthy test: {dateOfTest}</Text>
              ) : null}
              <View style={{ flexDirection: "row", marginTop: 12, gap: 8 }}>
                <TouchableOpacity style={styles.secondaryBtn} onPress={onScan}>
                  <Ionicons name="camera-outline" size={16} color={colors.text} />
                  <Text style={styles.secondaryBtnText}>Retake</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryBtn} onPress={onClear}>
                  <Ionicons name="trash-outline" size={16} color={colors.text} />
                  <Text style={styles.secondaryBtnText}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        ) : (
          <>
            <Ionicons name="scan-outline" size={40} color={colors.textSecondary} />
            <Text style={styles.discEmptyTitle}>Speed things up</Text>
            <Text style={styles.discEmptyBody}>
              Take a clear photo of the round disc on your windscreen. We{"\u2019"}ll read the VIN and roadworthy status for you.
            </Text>
            <TouchableOpacity style={styles.primaryBtnAlt} onPress={onScan}>
              <Ionicons name="camera" size={18} color={colors.text} />
              <Text style={styles.primaryBtnAltText}>
                {Platform.OS === "web" ? "Upload disc photo" : "Scan or upload disc"}
              </Text>
            </TouchableOpacity>
            <Text style={styles.discSkip}>Or tap Continue to skip this step.</Text>
          </>
        )}
      </View>
    </View>
  );
}

function StepCondition({ colors, styles, overall, setOverall, service, setService, accident, setAccident, damageNotes, setDamageNotes }: any) {
  return (
    <View>
      <StepTitle styles={styles} title="Condition" subtitle="Honest info gets you the best offer" />
      <FieldWrap styles={styles} label="Overall condition">
        <SegmentedControl styles={styles} options={["Excellent", "Good", "Fair", "Poor"]} value={overall} onChange={setOverall} />
      </FieldWrap>
      <FieldWrap styles={styles} label="Service history">
        <SegmentedControl styles={styles} options={["Full", "Partial", "None", "Not sure"]} value={service} onChange={setService} />
      </FieldWrap>
      <TouchableOpacity style={styles.consentRow} onPress={() => setAccident(!accident)} activeOpacity={0.7}>
        <View style={[styles.checkbox, accident && styles.checkboxOn]}>
          {accident ? <Ionicons name="checkmark" size={14} color={colors.onPrimary} /> : null}
        </View>
        <Text style={styles.consentText}>
          This vehicle has been in an accident or has structural / bodywork damage.
        </Text>
      </TouchableOpacity>
      {accident ? (
        <FieldWrap styles={styles} label="What was damaged?" hint="A short description helps us price accurately">
          <TextInput
            style={[styles.input, styles.inputMulti]}
            placeholder="e.g. Rear-ended, boot lid replaced, no chassis damage"
            placeholderTextColor={colors.textDisabled}
            value={damageNotes}
            onChangeText={setDamageNotes}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </FieldWrap>
      ) : null}
    </View>
  );
}

function StepPhotos({ colors, styles, photos, onAdd, onRemove }: any) {
  return (
    <View>
      <StepTitle styles={styles} title="Six photos" subtitle="All six are required — clear photos help us give an accurate offer" />
      <View style={styles.photoGrid}>
        {PHOTO_ORDER.map((p) => {
          const uri = photos[p.key];
          return (
            <View key={p.key} style={styles.photoCell}>
              <TouchableOpacity
                style={[styles.photoTile, uri && styles.photoTileFilled]}
                onPress={() => (uri ? onRemove(p.key) : onAdd(p.key))}
                activeOpacity={0.8}
              >
                {uri ? (
                  <>
                    <Image source={{ uri }} style={StyleSheet.absoluteFill as any} />
                    <View style={styles.photoOverlay}>
                      <Ionicons name="close" size={14} color="#FFFFFF" />
                      <Text style={styles.photoOverlayText}>Remove</Text>
                    </View>
                  </>
                ) : (
                  <>
                    <Ionicons name="add" size={26} color={colors.textSecondary} />
                    <Text style={styles.photoLabel}>{p.label}</Text>
                    <Text style={styles.photoHint}>{p.hint}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function StepReview({ colors, styles, summary, onEditStep, turnstileSiteKey, turnstileToken, onVerify, onExpire, submitError }: any) {
  const {
    fullName, phone, email,
    yearOfProduction, yearRegistered,
    make, fuelType, transmission, model, derivative,
    vin, mileage, colour,
    overall, service, accident, damageNotes,
  } = summary;
  return (
    <View>
      <StepTitle styles={styles} title="Review & submit" subtitle="Have a quick look then send it through" />

      {submitError ? (
        <View style={styles.errorBanner}>
          <Ionicons name="alert-circle" size={20} color={colors.danger} />
          <View style={{ flex: 1 }}>
            <Text style={styles.errorBannerTitle}>Couldn{"\u2019"}t submit</Text>
            <Text style={styles.errorBannerText}>{submitError}</Text>
          </View>
        </View>
      ) : null}

      <SummaryCard styles={styles} title="Your details" onEdit={() => onEditStep(1)}>
        <SummaryLine styles={styles} label="Name" value={fullName} />
        <SummaryLine styles={styles} label="Phone" value={phone} />
        <SummaryLine styles={styles} label="Email" value={email} />
      </SummaryCard>

      <SummaryCard styles={styles} title="Vehicle" onEdit={() => onEditStep(2)}>
        <SummaryLine styles={styles} label="Make" value={make} />
        <SummaryLine styles={styles} label="Model" value={model} />
        <SummaryLine styles={styles} label="Derivative" value={derivative} />
        <SummaryLine styles={styles} label="Fuel / Trans" value={`${fuelType || "—"} • ${transmission || "—"}`} />
        <SummaryLine styles={styles} label="Year (built / reg)" value={`${yearOfProduction ?? "—"} / ${yearRegistered ?? "—"}`} />
        <SummaryLine styles={styles} label="Mileage" value={`${mileage} km`} />
        {colour ? <SummaryLine styles={styles} label="Colour" value={colour} /> : null}
        {vin ? <SummaryLine styles={styles} label="VIN" value={vin} /> : null}
      </SummaryCard>

      <SummaryCard styles={styles} title="Condition" onEdit={() => onEditStep(4)}>
        <SummaryLine styles={styles} label="Overall" value={overall} />
        <SummaryLine styles={styles} label="Service history" value={service} />
        <SummaryLine styles={styles} label="Accident / damage" value={accident ? "Yes" : "No"} />
        {accident && damageNotes ? <SummaryLine styles={styles} label="Notes" value={damageNotes} /> : null}
      </SummaryCard>

      <View style={{ marginTop: 20 }}>
        <Text style={styles.turnstileHeader}>Prove you{"\u2019"}re human</Text>
        {turnstileSiteKey ? (
          <>
            <TurnstileWidget
              siteKey={turnstileSiteKey}
              action="public_valuation"
              theme="dark"
              onVerify={onVerify}
              onExpire={onExpire}
            />
            {Platform.OS === "web" && !turnstileToken ? (
              <Text style={styles.turnstileHint}>Tap the checkbox above to complete the challenge.</Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.turnstileMissing}>
            Anti-abuse widget is not configured. Please contact Fourbuy.
          </Text>
        )}
      </View>
    </View>
  );
}

function SuccessCard({ colors, styles, brandLogo, reference, message }: any) {
  // Redirect the seller to the main Fourbuy marketing site. On web
  // we prefer navigating the same tab (feels like a natural page
  // transition after Done); on native we hand off to the system
  // browser via `Linking.openURL`.
  const goToFourbuy = () => {
    const target = "https://www.fourbuy.co.za";
    try {
      if (Platform.OS === "web") {
        const w = (globalThis as any).window;
        if (w && w.location) {
          w.location.href = target;
          return;
        }
      }
    } catch {
      /* fall through to Linking */
    }
    Linking.openURL(target).catch(() => {});
  };

  return (
    <SafeAreaView style={[styles.safe, { justifyContent: "center" }]} edges={["top", "bottom"]}>
      {/* Slim brand header on the success page too — keeps the
          seller's mental context ("I'm still on Fourbuy's site") and
          matches the wizard's chrome so the transition feels tidy. */}
      <View style={styles.header}>
        <Image
          source={brandLogo}
          style={styles.headerLogo}
          resizeMode="contain"
          accessibilityLabel="Fourbuy Car Buying Co."
        />
      </View>
      <ScrollView contentContainerStyle={styles.successScroll}>
        <View style={styles.successWrap}>
          <View style={styles.successCircle}>
            <Ionicons name="checkmark" size={48} color={colors.onPrimary} />
          </View>
          <Text style={styles.successTitle}>Thank you!</Text>
          <Text style={styles.successBody}>{message || "We'll be in touch within 24 hours."}</Text>
          <View style={styles.refPill}>
            <Text style={styles.refPillLabel}>Reference</Text>
            <Text style={styles.refPillValue}>{reference}</Text>
          </View>
          <Text style={styles.successFooter}>
            Save this reference — we{"\u2019"}ll quote it in our WhatsApp and email response.
          </Text>

          {/* Primary CTA — send the seller to the main Fourbuy site
              to browse stock, read reviews, or contact the team while
              they wait for the valuation to land. Wider button + arrow
              icon reads as an outbound link rather than a form
              dismissal. */}
          <TouchableOpacity
            style={styles.successPrimaryBtn}
            onPress={goToFourbuy}
            accessibilityRole="link"
            accessibilityLabel="Visit fourbuy.co.za"
          >
            <Text style={styles.successPrimaryBtnText}>Visit fourbuy.co.za</Text>
            <Ionicons name="arrow-forward" size={18} color={colors.onPrimary} />
          </TouchableOpacity>
          <Text style={styles.successHint}>
            You can safely close this tab — your submission is saved.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function StepTitle({ styles, title, subtitle }: { styles: any; title: string; subtitle?: string }) {
  return (
    <View style={{ marginBottom: 20 }}>
      <Text style={styles.stepTitle}>{title}</Text>
      {subtitle ? <Text style={styles.stepSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

function FieldWrap({ styles, label, hint, children }: any) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function PickerField({ styles, label, value, onPress, disabled }: any) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.label}>{label}</Text>
      <TouchableOpacity
        style={[styles.pickerField, disabled && { opacity: 0.5 }]}
        onPress={onPress}
        activeOpacity={0.8}
      >
        <Text style={[styles.pickerValue, !value && styles.pickerValueDim]} numberOfLines={1}>
          {value ?? "Tap to choose"}
        </Text>
        <Ionicons name="chevron-down" size={16} color={styles.__colors?.textSecondary || "#8A8A8A"} />
      </TouchableOpacity>
    </View>
  );
}

function SegmentedControl({ styles, options, value, onChange }: any) {
  return (
    <View style={styles.segRow}>
      {options.map((opt: string) => {
        const selected = value === opt;
        return (
          <TouchableOpacity key={opt} style={[styles.segItem, selected && styles.segItemOn]} onPress={() => onChange(opt)} activeOpacity={0.8}>
            <Text style={[styles.segItemText, selected && styles.segItemTextOn]}>{opt}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function SummaryCard({ styles, title, onEdit, children }: any) {
  return (
    <View style={styles.summaryCard}>
      <View style={styles.summaryHeader}>
        <Text style={styles.summaryTitle}>{title}</Text>
        <TouchableOpacity onPress={onEdit}><Text style={styles.summaryEdit}>Edit</Text></TouchableOpacity>
      </View>
      {children}
    </View>
  );
}

function SummaryLine({ styles, label, value }: { styles: any; label: string; value?: string | number }) {
  return (
    <View style={styles.summaryLine}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue} numberOfLines={2}>{value || "—"}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Themed styles — pulls from the same `useThemeColors()` palette as the
// rest of the app so light/dark modes render identically to the dealer UI.
// ---------------------------------------------------------------------------
function makeStyles(colors: Palette) {
  return StyleSheet.create({
    // Outer container — flex:1 fills the parent, but on web we ALSO
    // clamp to 100dvh so the mobile browser's dynamic address bar
    // can't inflate our height beyond the visible viewport (which was
    // causing the "screen moves when scrolling" bug — the outer body
    // was scrolling instead of the ScrollView). `100dvh` (dynamic
    // viewport height) tracks the address-bar hide/show so our
    // scroll container is always exactly one screen tall.
    safe: {
      flex: 1,
      backgroundColor: colors.bg,
      ...(Platform.OS === "web" ? ({ height: "100dvh", maxHeight: "100dvh" } as any) : {}),
    },
    header: {
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 10,
      alignItems: "center",           // center the brand horizontally
      justifyContent: "center",
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.bg,
      // On web pin the header to the top of the scroll container so
      // mobile browsers can't push it off-screen when the address bar
      // hides. `zIndex` keeps the sticky header above any scroll
      // shadows.
      ...(Platform.OS === "web" ? ({
        position: "sticky" as any,
        top: 0,
        zIndex: 10,
      } as any) : {}),
    },
    // Logo dimensions — the Fourbuy wordmark PNG is 617×215 (~2.87:1).
    // 40px tall × 115 wide keeps it legible on the smallest supported
    // phone browser (iPhone SE, 320px CSS width) without dominating
    // the header. Increased from the previous text-only header for
    // brand recognition on the public-facing page.
    headerLogo: {
      width: 130,
      height: 46,
    },
    brand: {
      fontSize: 18,
      fontWeight: "800",
      letterSpacing: 3,
      color: colors.text,
      textAlign: "center",
    },
    brandSub: {
      fontSize: 9,
      letterSpacing: 3,
      color: colors.textSecondary,
      marginTop: 2,
      textAlign: "center",
    },
    headerBack: {
      display: "none",
    },
    headerBackText: { display: "none" as any },

    footerBtnRow: {
      flexDirection: "row",
      alignItems: "stretch",
      gap: 8,
    },
    backBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 18,
      paddingVertical: 15,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
      gap: 4,
    },
    backBtnText: {
      color: colors.text,
      fontSize: 15,
      fontWeight: "600",
      letterSpacing: 0.3,
    },

    progressBar: {
      height: 3,
      backgroundColor: colors.border,
      marginHorizontal: 16,
      marginTop: 12,
      borderRadius: 2,
      overflow: "hidden",
    },
    progressFill: { height: "100%", backgroundColor: colors.primary },
    progressLabelRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      marginTop: 6,
      marginBottom: 4,
    },
    progressLabel: { color: colors.textSecondary, fontSize: 11, letterSpacing: 1 },

    scroll: { padding: 16, paddingBottom: 24, maxWidth: 700, width: "100%", alignSelf: "center" },

    stepTitle: {
      fontSize: 24,
      fontWeight: "700",
      color: colors.text,
      letterSpacing: -0.5,
      marginBottom: 4,
    },
    stepSubtitle: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },

    label: {
      fontSize: 11,
      letterSpacing: 1.5,
      color: colors.textSecondary,
      marginBottom: 8,
      fontWeight: "600",
      textTransform: "uppercase",
    },
    hint: { fontSize: 12, color: colors.textDisabled, marginTop: 4, fontStyle: "italic" },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: Platform.OS === "web" ? 12 : 14,
      fontSize: 15,
      color: colors.text,
      backgroundColor: colors.inputBg,
    },
    inputMulti: { minHeight: 88, paddingTop: 12 },

    // Picker field — used everywhere in the vehicle step
    pickerField: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 14,
      backgroundColor: colors.inputBg,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    pickerValue: { fontSize: 15, color: colors.text, flex: 1, fontWeight: "500" },
    pickerValueDim: { color: colors.textDisabled, fontWeight: "400" },

    resetRow: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-end",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
      marginBottom: 4,
      marginTop: -12,
      borderRadius: 8,
    },
    resetText: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 1,
      textDecorationLine: "underline",
    },

    consentRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      paddingVertical: 8,
      marginTop: 8,
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 4,
      borderWidth: 2,
      borderColor: colors.border,
      marginRight: 12,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 2,
      backgroundColor: colors.inputBg,
    },
    checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    consentText: { flex: 1, color: colors.text, fontSize: 13, lineHeight: 19 },
    link: { textDecorationLine: "underline", fontWeight: "600" },

    discCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 20,
      alignItems: "center",
      backgroundColor: colors.paper,
    },
    discEmptyTitle: { fontSize: 16, fontWeight: "700", color: colors.text, marginTop: 12, marginBottom: 4 },
    discEmptyBody: { color: colors.textSecondary, fontSize: 13, textAlign: "center", lineHeight: 18, marginBottom: 16, paddingHorizontal: 8 },
    discSkip: { color: colors.textDisabled, fontSize: 12, marginTop: 12 },
    discImage: { width: "100%", aspectRatio: 1, maxWidth: 260, borderRadius: 8, backgroundColor: colors.card },
    discResults: { alignItems: "center", marginTop: 16, width: "100%" },
    discOk: { color: colors.success, fontSize: 13, fontWeight: "600" },
    discWarn: { color: colors.textSecondary, fontSize: 13, textAlign: "center" },
    discMuted: { color: colors.textDisabled, fontSize: 12, marginTop: 6, fontFamily: fonts.number },

    segRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    segItem: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      backgroundColor: colors.card,
    },
    segItemOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    segItemText: { color: colors.text, fontSize: 14, fontWeight: "500" },
    segItemTextOn: { color: colors.onPrimary },

    photoGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
    photoCell: { width: "48.5%", marginBottom: 10 },
    photoTile: {
      borderWidth: 1.5,
      borderColor: colors.border,
      borderStyle: "dashed",
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.paper,
      overflow: "hidden",
      padding: 8,
      aspectRatio: 1,
    },
    photoTileFilled: { borderStyle: "solid", borderColor: colors.primary },
    photoLabel: { fontSize: 13, fontWeight: "600", color: colors.text, marginTop: 6 },
    photoHint: { fontSize: 10, color: colors.textDisabled, textAlign: "center", marginTop: 2 },
    photoOverlay: {
      position: "absolute",
      top: 6, right: 6,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: "rgba(0,0,0,0.7)",
      paddingHorizontal: 8, paddingVertical: 4,
      borderRadius: 6,
    },
    photoOverlayText: { color: "#FFFFFF", fontSize: 11 },

    summaryCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 14,
      marginBottom: 12,
      backgroundColor: colors.card,
    },
    summaryHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 8,
    },
    summaryTitle: {
      fontSize: 12,
      letterSpacing: 1.5,
      fontWeight: "700",
      color: colors.text,
      textTransform: "uppercase",
    },
    summaryEdit: { fontSize: 13, color: colors.textSecondary, textDecorationLine: "underline" },
    summaryLine: { flexDirection: "row", paddingVertical: 4 },
    summaryLabel: { width: 128, color: colors.textSecondary, fontSize: 13 },
    summaryValue: { flex: 1, color: colors.text, fontSize: 13, fontWeight: "500" },

    turnstileHeader: {
      fontSize: 11,
      letterSpacing: 1.5,
      color: colors.textSecondary,
      marginBottom: 10,
      fontWeight: "600",
      textTransform: "uppercase",
    },
    turnstileHint: {
      color: colors.textSecondary,
      fontSize: 12,
      marginTop: 8,
      fontStyle: "italic",
    },
    turnstileMissing: {
      color: colors.danger,
      fontSize: 13,
      padding: 12,
      borderRadius: 8,
      backgroundColor: colors.card,
      borderColor: colors.danger,
      borderWidth: 1,
    },

    errorBanner: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
      padding: 12,
      borderRadius: 10,
      backgroundColor: colors.card,
      borderColor: colors.danger,
      borderWidth: 1.5,
      marginBottom: 16,
    },
    errorBannerTitle: { color: colors.danger, fontWeight: "700", fontSize: 13, marginBottom: 2 },
    errorBannerText: { color: colors.text, fontSize: 13, lineHeight: 18 },

    footer: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: Platform.OS === "ios" ? 12 : 16,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.bg,
    },
    primaryBtn: {
      backgroundColor: colors.primary,
      paddingVertical: 15,
      borderRadius: 10,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    primaryBtnText: { color: colors.onPrimary, fontSize: 15, fontWeight: "600", letterSpacing: 0.5 },
    primaryBtnAlt: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.text,
      paddingHorizontal: 20,
      paddingVertical: 13,
      borderRadius: 10,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      marginTop: 8,
    },
    primaryBtnAltText: { color: colors.text, fontSize: 14, fontWeight: "600" },
    secondaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.card,
    },
    secondaryBtnText: { color: colors.text, fontSize: 13, fontWeight: "500" },
    footerHint: {
      color: colors.textDisabled,
      fontSize: 11,
      textAlign: "center",
      marginTop: 8,
      letterSpacing: 0.3,
    },

    successWrap: {
      alignItems: "center",
      padding: 24,
      maxWidth: 480,
      alignSelf: "center",
    },
    // ScrollView wrapper for the success screen so long content on
    // small phone viewports (e.g. iPhone SE in landscape) never gets
    // clipped by the sticky header + safe area insets.
    successScroll: {
      flexGrow: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 24,
    },
    successCircle: {
      width: 88, height: 88,
      borderRadius: 44,
      backgroundColor: colors.success,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 20,
    },
    successTitle: {
      fontSize: 28,
      fontWeight: "700",
      color: colors.text,
      marginBottom: 8,
      letterSpacing: -0.5,
    },
    successBody: {
      color: colors.textSecondary,
      fontSize: 15,
      textAlign: "center",
      lineHeight: 22,
      marginBottom: 20,
      paddingHorizontal: 8,
    },
    refPill: {
      backgroundColor: colors.paper,
      paddingHorizontal: 20,
      paddingVertical: 14,
      borderRadius: 12,
      marginBottom: 16,
      alignItems: "center",
      minWidth: 200,
      borderWidth: 1,
      borderColor: colors.border,
    },
    refPillLabel: {
      color: colors.textSecondary,
      fontSize: 10,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      fontWeight: "600",
    },
    refPillValue: {
      color: colors.text,
      fontSize: 22,
      fontWeight: "700",
      marginTop: 4,
      letterSpacing: 1,
      fontFamily: fonts.number,
    },
    successFooter: {
      color: colors.textDisabled,
      fontSize: 12,
      textAlign: "center",
      marginBottom: 20,
      paddingHorizontal: 20,
    },
    // Bigger, more inviting primary CTA on the success screen —
    // full-width, elevated, arrow icon so it reads as an outbound
    // link back to the main Fourbuy site.
    successPrimaryBtn: {
      backgroundColor: colors.primary,
      paddingVertical: 16,
      paddingHorizontal: 28,
      borderRadius: 12,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      minWidth: 240,
      alignSelf: "stretch",
      ...Platform.select({
        ios: { shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 5 } },
        android: { elevation: 4 },
        default: {},
      }),
    },
    successPrimaryBtnText: {
      color: colors.onPrimary,
      fontSize: 16,
      fontWeight: "700",
      letterSpacing: 0.4,
    },
    successHint: {
      color: colors.textDisabled,
      fontSize: 11,
      textAlign: "center",
      marginTop: 12,
      fontStyle: "italic",
    },
  });
}
