import { useState, useMemo, useEffect } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, TextInput, Linking, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import BrandLogo from "@/src/components/BrandLogo";
import { spacing, radius, fonts, BRAND } from "@/src/theme";
import { darkPalette, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";

// WhatsApp business number the invitation requests should route to.
// Kept as a constant so it can be swapped without touching layout code.
const WHATSAPP_NUMBER = "27848819073"; // ZA — country code without the "+"

/**
 * Public dealer self-registration is disabled — every dealer account is
 * created by a Fourbuy administrator. This screen is kept in the router so
 * any existing bookmarks / QR codes still land somewhere friendly, and it
 * gives the prospective dealer a one-tap WhatsApp button that pre-fills the
 * request message with their dealership + contact name.
 */
export default function RegisterInvitationOnly() {
  const colors = darkPalette;
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ ref?: string }>();
  const [dealership, setDealership] = useState("");
  const [name, setName] = useState("");
  // Referral param arriving via a shared /register?ref=CODE link.
  const referralCode = (Array.isArray(params.ref) ? params.ref[0] : params.ref)?.toString().trim().toUpperCase() || null;
  const [referrer, setReferrer] = useState<{ name: string; dealership?: string | null } | null>(null);

  // Look up the referrer via the public /api/referral/lookup endpoint so
  // we can render a friendly "Referred by …" line at the top of the
  // invitation form. Silent-fail on unknown/invalid codes.
  useEffect(() => {
    if (!referralCode) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch(`/api/referral/lookup?code=${encodeURIComponent(referralCode)}`);
        if (!cancelled && r?.referrer_name) {
          setReferrer({ name: r.referrer_name, dealership: r.referrer_dealership });
        }
      } catch {
        /* unknown code — quietly ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [referralCode]);

  const sendOnWhatsApp = async () => {
    const dealerClean = dealership.trim();
    const nameClean = name.trim();
    if (!dealerClean || !nameClean) {
      Alert.alert(
        "Fill in both fields",
        "Please enter your dealership and your name so the Fourbuy team can help you quickly.",
      );
      return;
    }
    const referralLine = referralCode && referrer
      ? `• Referral code: ${referralCode} (from ${referrer.name})\n`
      : "";
    const message =
      `Hi Fourbuy 👋\n\n` +
      `I'd like to request a dealer account on the Fourbuy Car Buying Co. app.\n\n` +
      `• Dealership: ${dealerClean}\n` +
      `• My name: ${nameClean}\n` +
      referralLine +
      `\nPlease let me know what you need from us to get set up. Thank you!`;
    const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
    try {
      const supported = await Linking.canOpenURL(url);
      if (!supported) {
        // Fallback for platforms where wa.me isn't detected as openable.
        await Linking.openURL(url);
        return;
      }
      await Linking.openURL(url);
    } catch {
      Alert.alert(
        "Could not open WhatsApp",
        "Please make sure WhatsApp is installed, or contact us on +27 84 881 9073.",
      );
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.logoWrap}>
          <BrandLogo size="lg" variant="dark" />
        </View>

        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="lock-closed" size={26} color={colors.text} />
          </View>

          <Text style={styles.title}>Invitation only</Text>
          <Text style={styles.sub}>
            Fourbuy dealer accounts are created by a Fourbuy administrator so
            we can verify each dealership before you go live.
          </Text>

          {/* Referred-by banner — only shown when the `?ref=CODE` code
              resolves to a real dealer via /api/referral/lookup. If the
              code is missing OR unknown, we skip the banner entirely
              rather than showing a misleading "a Fourbuy dealer" line. */}
          {referralCode && referrer ? (
            <View style={styles.referralBanner} testID="referred-by-banner">
              <Ionicons name="ribbon" size={16} color={colors.text} />
              <View style={{ flex: 1 }}>
                <Text style={styles.referralBannerLabel}>REFERRED BY</Text>
                <Text style={styles.referralBannerName}>
                  {referrer.name}
                  {referrer.dealership ? `  ·  ${referrer.dealership}` : ""}
                </Text>
                <Text style={styles.referralBannerCode}>Code: {referralCode}</Text>
              </View>
            </View>
          ) : null}

          <View style={styles.stepsBox}>
            <View style={styles.step}>
              <Text style={styles.stepIndex}>1</Text>
              <Text style={styles.stepText}>
                Fill in your dealership and your name below.
              </Text>
            </View>
            <View style={styles.step}>
              <Text style={styles.stepIndex}>2</Text>
              <Text style={styles.stepText}>
                Tap the WhatsApp button — it opens a chat with the Fourbuy team
                pre-filled with your details.
              </Text>
            </View>
            <View style={styles.step}>
              <Text style={styles.stepIndex}>3</Text>
              <Text style={styles.stepText}>
                We&apos;ll set up your dealership and each user&apos;s login,
                then send you the credentials on WhatsApp.
              </Text>
            </View>
          </View>

          {/* Form */}
          <View style={styles.formRow}>
            <Text style={styles.label}>Dealership name</Text>
            <TextInput
              testID="register-dealership-input"
              style={styles.input}
              value={dealership}
              onChangeText={setDealership}
              placeholder="e.g. Hatfield Ford Bryanston"
              placeholderTextColor={colors.textDisabled}
              autoCapitalize="words"
              returnKeyType="next"
            />
          </View>
          <View style={styles.formRow}>
            <Text style={styles.label}>Your name</Text>
            <TextInput
              testID="register-name-input"
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. John Smith"
              placeholderTextColor={colors.textDisabled}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={sendOnWhatsApp}
            />
          </View>

          <TouchableOpacity
            testID="register-whatsapp-btn"
            style={styles.primaryBtn}
            onPress={sendOnWhatsApp}
          >
            <Ionicons name="logo-whatsapp" size={18} color="#000" />
            <Text style={styles.primaryBtnText}>Request via WhatsApp</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>
            Opens WhatsApp with a pre-filled message to +27 84 881 9073.
          </Text>

          <TouchableOpacity
            testID="register-back-btn"
            style={styles.ghostBtn}
            onPress={() => router.replace("/(auth)/login")}
          >
            <Ionicons name="arrow-back" size={14} color={colors.text} />
            <Text style={styles.ghostBtnText}>Back to sign in</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footerTag}>{BRAND.tagline}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    alignItems: "center",
  },
  logoWrap: {
    alignItems: "center",
    marginTop: spacing.xl,
    marginBottom: spacing.lg,
  },
  card: {
    width: "100%",
    maxWidth: 460,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    alignItems: "center",
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: 0.4,
    fontFamily: fonts.heading,
    marginBottom: 6,
  },
  sub: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
    marginBottom: spacing.lg,
  },
  stepsBox: {
    width: "100%",
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  step: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  stepIndex: {
    width: 22,
    height: 22,
    lineHeight: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    color: "#000",
    fontWeight: "900",
    textAlign: "center",
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  stepText: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  formRow: {
    width: "100%",
    marginBottom: spacing.sm,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  input: {
    width: "100%",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    backgroundColor: colors.paper,
    color: colors.text,
    fontSize: 14,
  },
  primaryBtn: {
    width: "100%",
    marginTop: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: radius.sm,
  },
  primaryBtnText: {
    color: "#000",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1,
  },
  hint: {
    marginTop: 8,
    color: colors.textSecondary,
    fontSize: 11,
    textAlign: "center",
  },
  ghostBtn: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  ghostBtnText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  footerTag: {
    marginTop: spacing.xl,
    color: colors.textSecondary,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  // "Referred by …" banner shown when the invitation screen is opened
  // via a /register?ref=CODE share link.
  referralBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  referralBannerLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  referralBannerName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800",
    marginTop: 2,
  },
  referralBannerCode: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
    fontFamily: fonts.mono,
    letterSpacing: 1,
  },
});
