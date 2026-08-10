/**
 * PUBLIC VALUATION PORTAL — Fourbuy Car Buying Co.
 *
 * Anonymous, no-login funnel for members of the public to submit their
 * vehicle for a free valuation. This route lives at `/get-valuation` and
 * is a whitelisted public path in `app/_layout.tsx` — it must NEVER be
 * moved under `(app)/` or `(auth)/` which are auth-gated.
 *
 * Six-step wizard:
 *   1. Seller       — name, phone, email, POPIA consent
 *   2. Vehicle      — year, make, model, mileage, VIN (opt), colour (opt)
 *   3. License disc — optional OCR scan / photo upload to auto-fill fields
 *   4. Condition    — overall grade, service history, accident flag
 *   5. Photos       — six mandatory slots (front / rear / L / R / interior / dash)
 *   6. Review       — summary, Cloudflare Turnstile, submit → success card
 *
 * Anti-abuse:
 *   - Cloudflare Turnstile (managed widget) — see `src/components/TurnstileWidget.tsx`
 *   - Backend rate-limit: 3/day per IP, 3/day per phone
 *   - Backend requires all 6 photo slots + POPIA consent + valid phone
 */
import { useState, useCallback, useRef } from "react";
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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";

import { TouchableOpacity } from "@/src/components/HapticButtons";
import TurnstileWidget from "@/src/components/TurnstileWidget";
import { decodeLicenseDisk } from "@/src/utils/licenseDisk";

// ---------------------------------------------------------------------------
// Palette — LIGHT-mode fixed. Public marketing surface, not tied to the
// dealer app's theme toggle. Editorial monochrome to match brand.
// ---------------------------------------------------------------------------
const P = {
  bg: "#FFFFFF",
  paper: "#F7F7F7",
  card: "#FFFFFF",
  border: "#E4E4E4",
  borderStrong: "#111111",
  text: "#0A0A0A",
  textDim: "#5A5A5A",
  textFaint: "#8A8A8A",
  primary: "#0A0A0A",
  onPrimary: "#FFFFFF",
  danger: "#B00020",
  success: "#0E7F3B",
  accentBg: "#F1F1F1",
};

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || "";
const TURNSTILE_SITE_KEY = process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY || "";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Overall = "Excellent" | "Good" | "Fair" | "Poor";
type ServiceHistory = "Full" | "Partial" | "None" | "Not sure";
type Transmission = "Automatic" | "Manual" | "";
type FuelType = "Petrol" | "Diesel" | "Hybrid" | "Electric" | "";

type PhotoSlot = "front" | "rear" | "left" | "right" | "interior" | "dash";
const PHOTO_ORDER: { key: PhotoSlot; label: string; hint: string }[] = [
  { key: "front", label: "Front", hint: "Full front, straight on" },
  { key: "rear", label: "Rear", hint: "Full rear, straight on" },
  { key: "left", label: "Left side", hint: "Passenger side, full length" },
  { key: "right", label: "Right side", hint: "Driver side, full length" },
  { key: "interior", label: "Interior", hint: "Front seats + dashboard" },
  { key: "dash", label: "Odometer", hint: "Dashboard showing mileage" },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
const isSaPhone = (v: string) => /^(\+?27|0)\d{9}$/.test(v.replace(/\s|-/g, ""));

async function pickPhoto(): Promise<string | null> {
  if (Platform.OS === "web") {
    const res = await ImagePicker.launchImageLibraryAsync({
      base64: true,
      quality: 0.5,
      allowsEditing: false,
      mediaTypes: ["images"],
    });
    if (res.canceled || !res.assets?.[0]?.base64) return null;
    return `data:image/jpeg;base64,${res.assets[0].base64}`;
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
              base64: true,
              quality: 0.5,
              allowsEditing: false,
              mediaTypes: ["images"],
            });
            if (r.canceled || !r.assets?.[0]?.base64) return resolve(null);
            resolve(`data:image/jpeg;base64,${r.assets[0].base64}`);
          },
        },
        {
          text: "Photo library",
          onPress: async () => {
            const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (!perm.granted) return resolve(null);
            const r = await ImagePicker.launchImageLibraryAsync({
              base64: true,
              quality: 0.5,
              allowsEditing: false,
              mediaTypes: ["images"],
            });
            if (r.canceled || !r.assets?.[0]?.base64) return resolve(null);
            resolve(`data:image/jpeg;base64,${r.assets[0].base64}`);
          },
        },
        { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------
const TOTAL_STEPS = 6;
const CURRENT_YEAR = new Date().getFullYear();

export default function GetValuationScreen() {
  const router = useRouter();
  const [step, setStep] = useState(1);

  // Seller
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);

  // Vehicle
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [derivative, setDerivative] = useState("");
  const [vin, setVin] = useState("");
  const [mileage, setMileage] = useState("");
  const [colour, setColour] = useState("");
  const [transmission, setTransmission] = useState<Transmission>("");
  const [fuelType, setFuelType] = useState<FuelType>("");
  const [dateOfTest, setDateOfTest] = useState<string | null>(null);
  const [licenseDiskData, setLicenseDiskData] = useState<string | null>(null);
  const [discPhoto, setDiscPhoto] = useState<string | null>(null);

  // Condition
  const [overall, setOverall] = useState<Overall | "">("");
  const [service, setService] = useState<ServiceHistory | "">("");
  const [accident, setAccident] = useState<boolean>(false);
  const [damageNotes, setDamageNotes] = useState("");

  // Photos
  const [photos, setPhotos] = useState<Record<PhotoSlot, string | null>>({
    front: null,
    rear: null,
    left: null,
    right: null,
    interior: null,
    dash: null,
  });

  // Anti-abuse + submission
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ reference: string; message: string } | null>(null);
  const scrollRef = useRef<ScrollView>(null);

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
        const y = parseInt(year || "0", 10);
        if (!(y >= 1980 && y <= CURRENT_YEAR + 1)) return `Year must be between 1980 and ${CURRENT_YEAR + 1}.`;
        if (make.trim().length < 1) return "Please enter the vehicle make.";
        if (model.trim().length < 1) return "Please enter the vehicle model.";
        const km = parseInt(mileage.replace(/\s|,/g, "") || "-1", 10);
        if (!(km >= 0 && km <= 2_000_000)) return "Please enter a valid mileage.";
        if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin.trim())) return "VIN must be 17 characters (no I / O / Q).";
      }
      // Step 3 (disc) is optional — no gate.
      if (s === 4) {
        if (!overall) return "Please choose an overall condition.";
        if (!service) return "Please choose a service history option.";
        if (accident && damageNotes.trim().length < 5) return "Please describe the damage briefly.";
      }
      if (s === 5) {
        for (const p of PHOTO_ORDER) {
          if (!photos[p.key]) return `Please add the ${p.label} photo.`;
        }
      }
      if (s === 6) {
        if (Platform.OS === "web" && !turnstileToken) return "Please complete the anti-abuse check.";
      }
      return null;
    },
    [fullName, phone, email, consent, year, make, model, mileage, vin, overall, service, accident, damageNotes, photos, turnstileToken],
  );

  const goNext = () => {
    const err = validateStep(step);
    if (err) {
      Alert.alert("One more thing", err);
      return;
    }
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
    if (parsed.make && !make) setMake(String(parsed.make));
    if (parsed.model && !model) setModel(String(parsed.model));
    if (parsed.colour && !colour) setColour(String(parsed.colour));
    if (parsed.dateOfTest) setDateOfTest(String(parsed.dateOfTest));
  };

  const handleScanDisc = async () => {
    const img = await pickPhoto();
    if (!img) return;
    setDiscPhoto(img);
    try {
      const r = await fetch(`${BACKEND_URL}/api/public/license-disk/decode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: img }),
      });
      const data = await r.json();
      if (!r.ok) {
        Alert.alert(
          "Couldn't read the disc",
          data?.detail || "We couldn't decode that photo. Try a sharper, close-up shot of the whole disc — or just skip and enter details manually.",
        );
        return;
      }
      if (data?.raw) setLicenseDiskData(data.raw);
      applyDiscParsed(data?.parsed || {});
      // If the raw came back and we didn't get parsed keys, try client parse.
      if (data?.raw && (!data?.parsed || !Object.keys(data.parsed).length)) {
        try {
          const p = decodeLicenseDisk(data.raw);
          applyDiscParsed(p);
        } catch {}
      }
      Alert.alert("Disc scanned", "We've pre-filled the vehicle details for you. Please review them on the next screen.");
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
    if (err) {
      Alert.alert("One more thing", err);
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        seller: {
          full_name: fullName.trim(),
          phone: phone.replace(/\s|-/g, ""),
          email: email.trim(),
          consent_accepted: true,
        },
        vehicle: {
          year: parseInt(year, 10),
          make: make.trim(),
          model: model.trim(),
          derivative: derivative.trim() || undefined,
          vin: vin.trim() ? vin.trim().toUpperCase() : undefined,
          mileage: parseInt(mileage.replace(/\s|,/g, ""), 10),
          colour: colour.trim() || undefined,
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
      if (!r.ok) {
        throw new Error(data?.detail || `Submission failed (HTTP ${r.status})`);
      }
      setResult({ reference: data.reference, message: data.message });
    } catch (e: any) {
      Alert.alert("Submission failed", e?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // ---------- success ----------
  if (result) {
    return <SuccessCard reference={result.reference} message={result.message} onDone={() => router.replace("/")} />;
  }

  // ---------- render ----------
  const progress = step / TOTAL_STEPS;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.brand}>FOURBUY</Text>
            <Text style={styles.brandSub}>CAR BUYING CO.</Text>
          </View>
          {step > 1 && !result ? (
            <TouchableOpacity onPress={goBack} style={styles.headerBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="chevron-back" size={20} color={P.text} />
              <Text style={styles.headerBackText}>Back</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Progress */}
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>
        <View style={styles.progressLabelRow}>
          <Text style={styles.progressLabel}>Step {step} of {TOTAL_STEPS}</Text>
          <Text style={styles.progressLabel}>{Math.round(progress * 100)}%</Text>
        </View>

        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {step === 1 ? (
            <StepSeller
              fullName={fullName} setFullName={setFullName}
              phone={phone} setPhone={setPhone}
              email={email} setEmail={setEmail}
              consent={consent} setConsent={setConsent}
            />
          ) : null}
          {step === 2 ? (
            <StepVehicle
              year={year} setYear={setYear}
              make={make} setMake={setMake}
              model={model} setModel={setModel}
              derivative={derivative} setDerivative={setDerivative}
              vin={vin} setVin={setVin}
              mileage={mileage} setMileage={setMileage}
              colour={colour} setColour={setColour}
              transmission={transmission} setTransmission={setTransmission}
              fuelType={fuelType} setFuelType={setFuelType}
            />
          ) : null}
          {step === 3 ? (
            <StepDisc
              discPhoto={discPhoto}
              onScan={handleScanDisc}
              onClear={() => {
                setDiscPhoto(null);
                setLicenseDiskData(null);
                setDateOfTest(null);
              }}
              didFillFields={!!(vin || make || model)}
              dateOfTest={dateOfTest}
            />
          ) : null}
          {step === 4 ? (
            <StepCondition
              overall={overall} setOverall={setOverall}
              service={service} setService={setService}
              accident={accident} setAccident={setAccident}
              damageNotes={damageNotes} setDamageNotes={setDamageNotes}
            />
          ) : null}
          {step === 5 ? (
            <StepPhotos photos={photos} onAdd={addPhoto} onRemove={removePhoto} />
          ) : null}
          {step === 6 ? (
            <StepReview
              summary={{
                fullName, phone, email,
                year, make, model, derivative, vin, mileage, colour,
                overall, service, accident, damageNotes,
              }}
              onEditStep={(s) => setStep(s)}
              turnstileSiteKey={TURNSTILE_SITE_KEY}
              onVerify={setTurnstileToken}
              onExpire={() => setTurnstileToken(null)}
            />
          ) : null}
        </ScrollView>

        {/* Sticky footer */}
        <View style={styles.footer}>
          {step < TOTAL_STEPS ? (
            <TouchableOpacity style={styles.primaryBtn} onPress={goNext}>
              <Text style={styles.primaryBtnText}>Continue</Text>
              <Ionicons name="arrow-forward" size={18} color={P.onPrimary} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.primaryBtn, submitting && { opacity: 0.6 }]}
              onPress={submit}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color={P.onPrimary} />
              ) : (
                <>
                  <Ionicons name="paper-plane" size={16} color={P.onPrimary} />
                  <Text style={styles.primaryBtnText}>Get my valuation</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          <Text style={styles.footerHint}>
            Free • No obligation • We{"\u2019"}ll WhatsApp and email your valuation within 24 hours
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Step components
// ---------------------------------------------------------------------------
function StepSeller(props: any) {
  const { fullName, setFullName, phone, setPhone, email, setEmail, consent, setConsent } = props;
  return (
    <View>
      <StepTitle title="Your details" subtitle="We'll send your valuation to these contacts" />
      <Field label="Full name">
        <TextInput
          style={styles.input}
          placeholder="Firstname Lastname"
          placeholderTextColor={P.textFaint}
          value={fullName}
          onChangeText={setFullName}
          autoCapitalize="words"
          returnKeyType="next"
        />
      </Field>
      <Field label="Mobile number" hint="South African mobile only (WhatsApp)">
        <TextInput
          style={styles.input}
          placeholder="082 123 4567"
          placeholderTextColor={P.textFaint}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          returnKeyType="next"
          maxLength={16}
        />
      </Field>
      <Field label="Email address">
        <TextInput
          style={styles.input}
          placeholder="you@example.com"
          placeholderTextColor={P.textFaint}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          returnKeyType="done"
        />
      </Field>
      <TouchableOpacity style={styles.consentRow} onPress={() => setConsent(!consent)} activeOpacity={0.7}>
        <View style={[styles.checkbox, consent && styles.checkboxOn]}>
          {consent ? <Ionicons name="checkmark" size={14} color="#FFFFFF" /> : null}
        </View>
        <Text style={styles.consentText}>
          I accept Fourbuy{"\u2019"}s <Text style={styles.link}>Privacy Notice</Text> and agree to be contacted by
          WhatsApp or email regarding this valuation (POPIA-compliant).
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function StepVehicle(props: any) {
  return (
    <View>
      <StepTitle title="Your vehicle" subtitle="A few basics — we'll polish the rest from your disc" />
      <View style={styles.row2}>
        <Field label="Year" style={{ flex: 1, marginRight: 8 }}>
          <TextInput
            style={styles.input}
            placeholder="2019"
            placeholderTextColor={P.textFaint}
            value={props.year}
            onChangeText={(t: string) => props.setYear(t.replace(/\D/g, "").slice(0, 4))}
            keyboardType="number-pad"
            maxLength={4}
          />
        </Field>
        <Field label="Mileage (km)" style={{ flex: 1, marginLeft: 8 }}>
          <TextInput
            style={styles.input}
            placeholder="85 000"
            placeholderTextColor={P.textFaint}
            value={props.mileage}
            onChangeText={(t: string) => props.setMileage(t.replace(/[^\d\s]/g, ""))}
            keyboardType="number-pad"
            maxLength={9}
          />
        </Field>
      </View>
      <Field label="Make">
        <TextInput
          style={styles.input}
          placeholder="BMW"
          placeholderTextColor={P.textFaint}
          value={props.make}
          onChangeText={props.setMake}
          autoCapitalize="words"
        />
      </Field>
      <Field label="Model">
        <TextInput
          style={styles.input}
          placeholder="3 Series"
          placeholderTextColor={P.textFaint}
          value={props.model}
          onChangeText={props.setModel}
          autoCapitalize="words"
        />
      </Field>
      <Field label="Variant / trim (optional)">
        <TextInput
          style={styles.input}
          placeholder="320i M Sport"
          placeholderTextColor={P.textFaint}
          value={props.derivative}
          onChangeText={props.setDerivative}
        />
      </Field>
      <Field label="VIN (optional but recommended)" hint="17 characters, e.g. WBA22CA0609U91380">
        <TextInput
          style={styles.input}
          placeholder="WBA22CA0609U91380"
          placeholderTextColor={P.textFaint}
          value={props.vin}
          onChangeText={(t: string) => props.setVin(t.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17))}
          autoCapitalize="characters"
          maxLength={17}
        />
      </Field>
      <View style={styles.row2}>
        <Field label="Colour (optional)" style={{ flex: 1, marginRight: 8 }}>
          <TextInput
            style={styles.input}
            placeholder="White"
            placeholderTextColor={P.textFaint}
            value={props.colour}
            onChangeText={props.setColour}
            autoCapitalize="words"
          />
        </Field>
      </View>
      <Field label="Transmission (optional)">
        <SegmentedControl
          options={["Automatic", "Manual"]}
          value={props.transmission}
          onChange={(v: string) => props.setTransmission(v as Transmission)}
        />
      </Field>
      <Field label="Fuel type (optional)">
        <SegmentedControl
          options={["Petrol", "Diesel", "Hybrid", "Electric"]}
          value={props.fuelType}
          onChange={(v: string) => props.setFuelType(v as FuelType)}
        />
      </Field>
    </View>
  );
}

function StepDisc(props: any) {
  const { discPhoto, onScan, onClear, didFillFields, dateOfTest } = props;
  return (
    <View>
      <StepTitle
        title="License disc (optional)"
        subtitle="Snap or upload your license disc — we'll auto-fill VIN, colour and roadworthy status"
      />
      <View style={styles.discCard}>
        {discPhoto ? (
          <>
            <Image source={{ uri: discPhoto }} style={styles.discImage} resizeMode="cover" />
            <View style={styles.discResults}>
              {didFillFields ? (
                <Text style={styles.discOk}>
                  <Ionicons name="checkmark-circle" size={14} color={P.success} />
                  {"  Details captured. You can review them by tapping Back."}
                </Text>
              ) : (
                <Text style={styles.discWarn}>
                  We saved a photo of your disc but couldn{"\u2019"}t fill in details — that{"\u2019"}s OK, you already entered them.
                </Text>
              )}
              {dateOfTest ? (
                <Text style={styles.discMuted}>Last roadworthy test: {dateOfTest}</Text>
              ) : null}
              <View style={{ flexDirection: "row", marginTop: 12, gap: 8 }}>
                <TouchableOpacity style={styles.secondaryBtn} onPress={onScan}>
                  <Ionicons name="camera-outline" size={16} color={P.text} />
                  <Text style={styles.secondaryBtnText}>Retake</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryBtn} onPress={onClear}>
                  <Ionicons name="trash-outline" size={16} color={P.text} />
                  <Text style={styles.secondaryBtnText}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        ) : (
          <>
            <Ionicons name="scan-outline" size={40} color={P.textDim} />
            <Text style={styles.discEmptyTitle}>Speed things up</Text>
            <Text style={styles.discEmptyBody}>
              Take a clear photo of the round disc on your windscreen. We{"\u2019"}ll read the VIN, colour and roadworthy status for you.
            </Text>
            <TouchableOpacity style={styles.primaryBtnAlt} onPress={onScan}>
              <Ionicons name="camera" size={18} color={P.text} />
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

function StepCondition(props: any) {
  const { overall, setOverall, service, setService, accident, setAccident, damageNotes, setDamageNotes } = props;
  return (
    <View>
      <StepTitle title="Condition" subtitle="Honest info gets you the best offer" />
      <Field label="Overall condition">
        <SegmentedControl
          options={["Excellent", "Good", "Fair", "Poor"]}
          value={overall}
          onChange={setOverall}
        />
      </Field>
      <Field label="Service history">
        <SegmentedControl
          options={["Full", "Partial", "None", "Not sure"]}
          value={service}
          onChange={setService}
        />
      </Field>
      <TouchableOpacity style={styles.consentRow} onPress={() => setAccident(!accident)} activeOpacity={0.7}>
        <View style={[styles.checkbox, accident && styles.checkboxOn]}>
          {accident ? <Ionicons name="checkmark" size={14} color="#FFFFFF" /> : null}
        </View>
        <Text style={styles.consentText}>
          This vehicle has been in an accident or has structural / bodywork damage.
        </Text>
      </TouchableOpacity>
      {accident ? (
        <Field label="What was damaged?" hint="A short description helps us price accurately">
          <TextInput
            style={[styles.input, styles.inputMulti]}
            placeholder="e.g. Rear-ended, boot lid replaced, no chassis damage"
            placeholderTextColor={P.textFaint}
            value={damageNotes}
            onChangeText={setDamageNotes}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </Field>
      ) : null}
    </View>
  );
}

function StepPhotos({ photos, onAdd, onRemove }: any) {
  return (
    <View>
      <StepTitle title="Six photos" subtitle="All six are required — clear photos help us give an accurate offer" />
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
                    <Ionicons name="add" size={26} color={P.textDim} />
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

function StepReview({ summary, onEditStep, turnstileSiteKey, onVerify, onExpire }: any) {
  const { fullName, phone, email, year, make, model, derivative, vin, mileage, colour, overall, service, accident, damageNotes } = summary;
  return (
    <View>
      <StepTitle title="Review & submit" subtitle="Have a quick look then send it through" />

      <SummaryCard title="Your details" onEdit={() => onEditStep(1)}>
        <SummaryLine label="Name" value={fullName} />
        <SummaryLine label="Phone" value={phone} />
        <SummaryLine label="Email" value={email} />
      </SummaryCard>

      <SummaryCard title="Vehicle" onEdit={() => onEditStep(2)}>
        <SummaryLine label="Year" value={year} />
        <SummaryLine label="Make" value={make} />
        <SummaryLine label="Model" value={model} />
        {derivative ? <SummaryLine label="Variant" value={derivative} /> : null}
        {vin ? <SummaryLine label="VIN" value={vin} /> : null}
        <SummaryLine label="Mileage" value={`${mileage} km`} />
        {colour ? <SummaryLine label="Colour" value={colour} /> : null}
      </SummaryCard>

      <SummaryCard title="Condition" onEdit={() => onEditStep(4)}>
        <SummaryLine label="Overall" value={overall} />
        <SummaryLine label="Service history" value={service} />
        <SummaryLine label="Accident / damage" value={accident ? "Yes" : "No"} />
        {accident && damageNotes ? <SummaryLine label="Notes" value={damageNotes} /> : null}
      </SummaryCard>

      <View style={{ marginTop: 20 }}>
        <Text style={styles.turnstileHeader}>Prove you{"\u2019"}re human</Text>
        {turnstileSiteKey ? (
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            action="public_valuation"
            theme="light"
            onVerify={onVerify}
            onExpire={onExpire}
          />
        ) : (
          <Text style={styles.turnstileMissing}>
            Anti-abuse widget is not configured. Please contact Fourbuy.
          </Text>
        )}
      </View>
    </View>
  );
}

function SuccessCard({ reference, message, onDone }: any) {
  return (
    <SafeAreaView style={[styles.safe, { justifyContent: "center" }]} edges={["top", "bottom"]}>
      <View style={styles.successWrap}>
        <View style={styles.successCircle}>
          <Ionicons name="checkmark" size={44} color="#FFFFFF" />
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
        <TouchableOpacity style={styles.primaryBtn} onPress={onDone}>
          <Text style={styles.primaryBtnText}>Done</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function StepTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={{ marginBottom: 20 }}>
      <Text style={styles.stepTitle}>{title}</Text>
      {subtitle ? <Text style={styles.stepSubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

function Field({ label, hint, children, style }: any) {
  return (
    <View style={[{ marginBottom: 16 }, style]}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function SegmentedControl({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.segRow}>
      {options.map((opt) => {
        const selected = value === opt;
        return (
          <TouchableOpacity
            key={opt}
            style={[styles.segItem, selected && styles.segItemOn]}
            onPress={() => onChange(opt)}
            activeOpacity={0.8}
          >
            <Text style={[styles.segItemText, selected && styles.segItemTextOn]}>{opt}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function SummaryCard({ title, onEdit, children }: any) {
  return (
    <View style={styles.summaryCard}>
      <View style={styles.summaryHeader}>
        <Text style={styles.summaryTitle}>{title}</Text>
        <TouchableOpacity onPress={onEdit}>
          <Text style={styles.summaryEdit}>Edit</Text>
        </TouchableOpacity>
      </View>
      {children}
    </View>
  );
}

function SummaryLine({ label, value }: { label: string; value?: string | number }) {
  return (
    <View style={styles.summaryLine}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue} numberOfLines={2}>{value || "—"}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: P.bg },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: P.border,
    backgroundColor: P.bg,
  },
  brand: {
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 3,
    color: P.text,
  },
  brandSub: {
    fontSize: 9,
    letterSpacing: 3,
    color: P.textDim,
    marginTop: 2,
  },
  headerBack: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  headerBackText: { color: P.text, fontSize: 14, fontWeight: "500" },
  progressBar: {
    height: 3,
    backgroundColor: P.border,
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: P.primary,
  },
  progressLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    marginTop: 6,
    marginBottom: 4,
  },
  progressLabel: { color: P.textFaint, fontSize: 11, letterSpacing: 1 },

  scroll: { padding: 16, paddingBottom: 24, maxWidth: 700, width: "100%", alignSelf: "center" },

  stepTitle: {
    fontSize: 24,
    fontWeight: "700",
    color: P.text,
    letterSpacing: -0.5,
    marginBottom: 4,
  },
  stepSubtitle: { color: P.textDim, fontSize: 14, lineHeight: 20 },

  label: {
    fontSize: 11,
    letterSpacing: 1.5,
    color: P.textFaint,
    marginBottom: 8,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  hint: {
    fontSize: 12,
    color: P.textFaint,
    marginTop: 4,
    fontStyle: "italic",
  },
  input: {
    borderWidth: 1,
    borderColor: P.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "web" ? 12 : 14,
    fontSize: 15,
    color: P.text,
    backgroundColor: P.card,
  },
  inputMulti: { minHeight: 88, paddingTop: 12 },
  row2: { flexDirection: "row" },

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
    borderColor: P.borderStrong,
    marginRight: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  checkboxOn: { backgroundColor: P.primary, borderColor: P.primary },
  consentText: { flex: 1, color: P.text, fontSize: 13, lineHeight: 19 },
  link: { textDecorationLine: "underline", fontWeight: "600" },

  discCard: {
    borderWidth: 1,
    borderColor: P.border,
    borderRadius: 12,
    padding: 20,
    alignItems: "center",
    backgroundColor: P.paper,
  },
  discEmptyTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: P.text,
    marginTop: 12,
    marginBottom: 4,
  },
  discEmptyBody: {
    color: P.textDim,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
    marginBottom: 16,
    paddingHorizontal: 8,
  },
  discSkip: { color: P.textFaint, fontSize: 12, marginTop: 12 },
  discImage: {
    width: "100%",
    aspectRatio: 1,
    maxWidth: 260,
    borderRadius: 8,
    backgroundColor: P.card,
  },
  discResults: { alignItems: "center", marginTop: 16, width: "100%" },
  discOk: { color: P.success, fontSize: 13, fontWeight: "600" },
  discWarn: { color: P.textDim, fontSize: 13, textAlign: "center" },
  discMuted: { color: P.textFaint, fontSize: 12, marginTop: 6 },

  segRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  segItem: {
    borderWidth: 1,
    borderColor: P.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: P.card,
  },
  segItemOn: { backgroundColor: P.primary, borderColor: P.primary },
  segItemText: { color: P.text, fontSize: 14, fontWeight: "500" },
  segItemTextOn: { color: P.onPrimary },

  photoGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  photoCell: { width: "48.5%", marginBottom: 10 },
  photoTile: {
    borderWidth: 1.5,
    borderColor: P.border,
    borderStyle: "dashed",
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: P.paper,
    overflow: "hidden",
    padding: 8,
    aspectRatio: 1,
  },
  photoTileFilled: { borderStyle: "solid", borderColor: P.borderStrong },
  photoLabel: { fontSize: 13, fontWeight: "600", color: P.text, marginTop: 6 },
  photoHint: { fontSize: 10, color: P.textFaint, textAlign: "center", marginTop: 2 },
  photoOverlay: {
    position: "absolute",
    top: 6,
    right: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  photoOverlayText: { color: "#FFFFFF", fontSize: 11 },

  summaryCard: {
    borderWidth: 1,
    borderColor: P.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    backgroundColor: P.card,
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
    color: P.text,
    textTransform: "uppercase",
  },
  summaryEdit: { fontSize: 13, color: P.textDim, textDecorationLine: "underline" },
  summaryLine: { flexDirection: "row", paddingVertical: 4 },
  summaryLabel: { width: 108, color: P.textFaint, fontSize: 13 },
  summaryValue: { flex: 1, color: P.text, fontSize: 13, fontWeight: "500" },

  turnstileHeader: {
    fontSize: 11,
    letterSpacing: 1.5,
    color: P.textFaint,
    marginBottom: 10,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  turnstileMissing: {
    color: P.danger,
    fontSize: 13,
    padding: 12,
    borderRadius: 8,
    backgroundColor: "#FFF0F0",
    borderColor: "#F5C2C2",
    borderWidth: 1,
  },

  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: Platform.OS === "ios" ? 12 : 16,
    borderTopWidth: 1,
    borderTopColor: P.border,
    backgroundColor: P.bg,
  },
  primaryBtn: {
    backgroundColor: P.primary,
    paddingVertical: 15,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  primaryBtnText: { color: P.onPrimary, fontSize: 15, fontWeight: "600", letterSpacing: 0.5 },
  primaryBtnAlt: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: P.borderStrong,
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginTop: 8,
  },
  primaryBtnAltText: { color: P.text, fontSize: 14, fontWeight: "600" },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: P.border,
    borderRadius: 8,
    backgroundColor: P.card,
  },
  secondaryBtnText: { color: P.text, fontSize: 13, fontWeight: "500" },
  footerHint: {
    color: P.textFaint,
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
  successCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: P.success,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  successTitle: {
    fontSize: 28,
    fontWeight: "700",
    color: P.text,
    marginBottom: 8,
    letterSpacing: -0.5,
  },
  successBody: {
    color: P.textDim,
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 20,
    paddingHorizontal: 8,
  },
  refPill: {
    backgroundColor: P.accentBg,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 12,
    marginBottom: 16,
    alignItems: "center",
    minWidth: 200,
  },
  refPillLabel: {
    color: P.textFaint,
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    fontWeight: "600",
  },
  refPillValue: {
    color: P.text,
    fontSize: 22,
    fontWeight: "700",
    marginTop: 4,
    letterSpacing: 1,
  },
  successFooter: {
    color: P.textFaint,
    fontSize: 12,
    textAlign: "center",
    marginBottom: 20,
    paddingHorizontal: 20,
  },
});
