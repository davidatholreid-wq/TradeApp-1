import { useState, useMemo } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Image,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts, BRAND } from "@/src/theme";
import { darkPalette, type Palette } from "@/src/theme/ThemeContext";
import { useAuth } from "@/src/context/AuthContext";

// Marketing bullets shown on the hero side of the login screen — they
// mirror the four pillars of the TradeAPP dealer app so a first-time
// visitor immediately sees what the platform does before they sign in.
const HERO_BULLETS: { icon: keyof typeof Ionicons.glyphMap; text: string }[] = [
  { icon: "shield-checkmark-outline", text: "Get confirmed Trade Covers" },
  { icon: "swap-horizontal-outline", text: "Give Trade Covers on other dealers' stock" },
  { icon: "briefcase-outline", text: "Full trade-in management system" },
  { icon: "leaf-outline", text: "Trade responsibly" },
];

// Feb 2027 — the login hero no longer uses a background image.
// Previously we layered a car-showroom shot beneath the wordmark;
// after the rebrand the same "TRADE APP" logo was showing both as
// the poster AND as the foreground `BRAND.logo`, so users saw two
// stacked wordmarks. A clean solid-black hero with the wordmark
// centred reads far better and matches the app's home-screen freeze
// frame.

export default function Login() {
  const colors = darkPalette;
  const { width } = useWindowDimensions();

  // Breakpoints
  //   ≥ 1024 : true desktop — full split-screen with a wide hero panel
  //   ≥  768 : tablet — narrower split with a compact hero
  //   <  768 : phone — hero on top, form below (stacked)
  const layout: "desktop" | "tablet" | "phone" =
    width >= 1024 ? "desktop" : width >= 768 ? "tablet" : "phone";

  const styles = useMemo(() => makeStyles(colors, layout), [colors, layout]);

  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      setError("Please enter your email and password.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await login(email.trim(), password);
      router.replace("/(app)");
    } catch (e: any) {
      setError(e?.message || "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // ---------------- Hero panel (brand + bullets) --------------------
  // Solid-black hero (no background image) — the brand wordmark is
  // rendered by BrandLogo below, centred cleanly against the surface.
  const HeroPanel = (
    <View style={[styles.hero, styles.heroSolid]}>
      <View style={styles.heroContent}>
        <Image
          source={BRAND.logo}
          style={styles.heroLogo}
          resizeMode="contain"
          accessibilityLabel="TradeAPP"
        />
        {layout !== "phone" ? (
          <>
            <Text style={styles.heroHeadline}>
              The complete dealer{"\n"}trade platform.
            </Text>
            <Text style={styles.heroSub}>
              Get and give Trade Covers, manage every trade-in from valuation to sale, and pull
              factory-option and accident history reports — all in one place.
            </Text>
            <View style={styles.bullets}>
              {HERO_BULLETS.map((b) => (
                <View key={b.text} style={styles.bulletRow}>
                  <View style={styles.bulletIcon}>
                    <Ionicons name={b.icon} size={16} color={colors.text} />
                  </View>
                  <Text style={styles.bulletText}>{b.text}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.heroFootTag}>{BRAND.tagline}</Text>
          </>
        ) : (
          // Compact mobile hero: brand + tagline only.
          <Text style={styles.heroHeadlineMobile}>Dealer portal</Text>
        )}
      </View>
    </View>
  );

  // --------------- Form panel (inputs + CTAs) -------------------------
  const FormPanel = (
    <View style={styles.formOuter}>
      <View style={styles.formInner}>
        <Text style={styles.formTitle}>Sign in</Text>
        <Text style={styles.formSubtitle}>
          {layout === "phone"
            ? "Get and give Trade Covers. Manage every trade-in in one app."
            : "Welcome back. Please enter your details."}
        </Text>

        <View style={styles.field}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            testID="login-email-input"
            style={styles.input}
            value={email}
            onChangeText={(v) => {
              setEmail(v);
              if (error) setError(null);
            }}
            placeholder="you@dealer.co.za"
            placeholderTextColor={colors.textDisabled}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            returnKeyType="next"
          />
        </View>

        <View style={styles.field}>
          <View style={styles.labelRow}>
            <Text style={styles.label}>Password</Text>
            <TouchableOpacity onPress={() => setShowPassword((s) => !s)} accessibilityRole="button">
              <Text style={styles.labelAction}>{showPassword ? "Hide" : "Show"}</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            testID="login-password-input"
            style={styles.input}
            value={password}
            onChangeText={(v) => {
              setPassword(v);
              if (error) setError(null);
            }}
            placeholder="Enter your password"
            placeholderTextColor={colors.textDisabled}
            secureTextEntry={!showPassword}
            returnKeyType="go"
            onSubmitEditing={handleLogin}
          />
        </View>

        {error ? (
          <View style={styles.errorRow} testID="login-error">
            <Ionicons name="alert-circle" size={16} color={colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* Forgot password — small right-aligned link so it doesn't
            compete with the primary Sign In CTA. Deep-links into the
            ForgotPassword screen which handles the reset email flow. */}
        <TouchableOpacity
          testID="login-forgot-password-link"
          onPress={() => router.push("/(auth)/forgot-password")}
          style={styles.forgotWrap}
          accessibilityRole="link"
        >
          <Text style={styles.forgotText}>Forgot password?</Text>
        </TouchableOpacity>

        <TouchableOpacity
          testID="login-submit-button"
          style={[styles.primaryBtn, loading && styles.disabledBtn]}
          onPress={handleLogin}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.primaryBtnText}>Sign in</Text>
          )}
        </TouchableOpacity>

        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>OR</Text>
          <View style={styles.dividerLine} />
        </View>

        <TouchableOpacity
          testID="login-request-account-link"
          style={styles.secondaryBtn}
          onPress={() => router.push("/(auth)/register")}
        >
          <Ionicons name="add-circle-outline" size={16} color={colors.text} />
          <Text style={styles.secondaryBtnText}>Request dealer access</Text>
        </TouchableOpacity>

        <Text style={styles.footNote}>
          Need help? Email{" "}
          <Text style={styles.footNoteEm}>support@tradeapp.co.za</Text>
        </Text>
      </View>
    </View>
  );

  // ---------------- Layout composition --------------------------------
  if (layout === "phone") {
    return (
      <SafeAreaView style={styles.safeMobile} edges={["top", "bottom"]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.flex}
        >
          <ScrollView
            contentContainerStyle={styles.mobileScroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.mobileHeroWrap}>{HeroPanel}</View>
            <View style={styles.mobileFormWrap}>{FormPanel}</View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // Desktop / tablet split
  return (
    <View style={styles.splitContainer}>
      <View style={styles.splitLeft}>{HeroPanel}</View>
      <View style={styles.splitRight}>
        <SafeAreaView style={styles.flex} edges={["top", "bottom"]}>
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={styles.flex}
          >
            <ScrollView
              contentContainerStyle={styles.splitFormScroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {FormPanel}
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </View>
    </View>
  );
}

// -------------------------- styles ---------------------------------
const makeStyles = (colors: Palette, layout: "desktop" | "tablet" | "phone") => {
  const isPhone = layout === "phone";
  const isDesktop = layout === "desktop";
  return StyleSheet.create({
    flex: { flex: 1 },

    // -------- SPLIT container (desktop + tablet) --------
    splitContainer: { flex: 1, flexDirection: "row", backgroundColor: colors.bg },
    splitLeft: { flex: isDesktop ? 1.2 : 1 },
    splitRight: {
      flex: 1,
      backgroundColor: colors.bg,
      justifyContent: "center",
    },
    splitFormScroll: {
      flexGrow: 1,
      justifyContent: "center",
      alignItems: "center",
      paddingVertical: spacing.xl,
      paddingHorizontal: spacing.lg,
    },

    // -------- MOBILE stack --------
    safeMobile: { flex: 1, backgroundColor: colors.bg },
    mobileScroll: { flexGrow: 1 },
    // Feb 2027 — solid hero (no image), give the wordmark more room.
    mobileHeroWrap: { height: 220 },
    mobileFormWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl },

    // -------- HERO panel --------
    hero: { flex: 1, backgroundColor: "#0A0A0A" },
    // Solid variant used when no background image is set — centers the
    // wordmark on a clean dark surface for the login screen. Feb 2027.
    heroSolid: {
      alignItems: "center",
      justifyContent: "center",
    },
    heroImage: {
      // Full colour on desktop, slightly dimmed on tablet.
      opacity: isDesktop ? 0.9 : 0.75,
      resizeMode: "cover",
    },
    heroOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: isPhone ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.45)",
    },
    heroContent: {
      flex: 1,
      // Feb 2027 — solid hero has no background image, so centre the
      // logo + tagline for a clean minimalist login on phones. Desktop
      // + tablet still use flex-start for their multi-line copy blocks.
      justifyContent: isPhone ? "center" : "center",
      alignItems: isPhone ? "center" : "flex-start",
      paddingHorizontal: isDesktop ? 64 : spacing.xl,
      paddingVertical: isPhone ? spacing.lg : spacing.xl * 2,
      gap: spacing.md,
    },
    heroLogo: {
      // Feb 2027 — logo is centred on the phone hero now that the
      // duplicate poster is gone. Bumped up to 240×98 on phones so
      // it reads confidently at the top of the login screen.
      width: isDesktop ? 260 : isPhone ? 240 : 220,
      height: isDesktop ? 96 : isPhone ? 98 : 82,
      alignSelf: isPhone ? "center" : "flex-start",
      marginBottom: spacing.md,
    },
    heroHeadline: {
      color: "#FFFFFF",
      fontFamily: fonts.heading,
      fontSize: isDesktop ? 40 : 30,
      lineHeight: isDesktop ? 46 : 36,
      fontWeight: "800",
      letterSpacing: -0.5,
      textShadowColor: "rgba(0,0,0,0.55)",
      textShadowRadius: 8,
    },
    heroHeadlineMobile: {
      color: "#FFFFFF",
      fontFamily: fonts.heading,
      fontSize: 22,
      letterSpacing: 3,
      textTransform: "uppercase",
      fontWeight: "800",
      textShadowColor: "rgba(0,0,0,0.55)",
      textShadowRadius: 6,
    },
    heroSub: {
      color: "rgba(255,255,255,0.9)",
      fontSize: 15,
      lineHeight: 22,
      maxWidth: 460,
      textShadowColor: "rgba(0,0,0,0.55)",
      textShadowRadius: 6,
    },
    bullets: { marginTop: spacing.md, gap: spacing.sm },
    bulletRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    bulletIcon: {
      width: 30, height: 30, borderRadius: 15,
      backgroundColor: "rgba(255,255,255,0.14)",
      borderWidth: 1, borderColor: "rgba(255,255,255,0.28)",
      alignItems: "center", justifyContent: "center",
    },
    bulletText: {
      color: "rgba(255,255,255,0.9)",
      fontSize: 14,
      flex: 1,
    },
    heroFootTag: {
      color: "rgba(255,255,255,0.6)",
      fontStyle: "italic",
      fontFamily: fonts.serif,
      fontSize: 12,
      marginTop: spacing.xl,
      letterSpacing: 0.4,
    },

    // -------- FORM panel --------
    formOuter: {
      width: "100%",
      maxWidth: 420,
      alignSelf: "center",
    },
    formInner: {
      backgroundColor: isPhone ? "transparent" : colors.card,
      borderRadius: isPhone ? 0 : radius.lg,
      padding: isPhone ? 0 : spacing.xl,
      borderWidth: isPhone ? 0 : 1,
      borderColor: colors.border,
      gap: spacing.md,
    },
    formTitle: {
      color: colors.text,
      fontFamily: fonts.heading,
      fontSize: 26,
      fontWeight: "800",
      letterSpacing: -0.2,
    },
    formSubtitle: {
      color: colors.textSecondary,
      fontSize: 14,
      lineHeight: 20,
      marginTop: -spacing.sm,
      marginBottom: spacing.sm,
    },
    field: { gap: 6 },
    labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    label: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 1,
      textTransform: "uppercase",
    },
    labelAction: { color: colors.text, fontSize: 12, fontWeight: "700" },
    input: {
      backgroundColor: colors.inputBg,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 14,
      color: colors.text,
      fontSize: 15,
      minHeight: 48,
    },
    errorRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: "rgba(255,68,68,0.08)",
      borderWidth: 1,
      borderColor: "rgba(255,68,68,0.35)",
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 10,
    },
    errorText: { color: colors.danger, fontSize: 13, flex: 1 },
    // "Forgot password?" mini-link, positioned above the primary CTA
    // and right-aligned so it doesn't compete visually.
    forgotWrap: {
      alignSelf: "flex-end",
      marginTop: 2,
      paddingVertical: 4,
      paddingHorizontal: 2,
    },
    forgotText: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: "700",
      textDecorationLine: "underline",
    },
    primaryBtn: {
      backgroundColor: colors.primary,
      borderRadius: radius.md,
      paddingVertical: 16,
      alignItems: "center",
      marginTop: spacing.xs,
    },
    disabledBtn: { opacity: 0.6 },
    primaryBtnText: {
      color: colors.onPrimary,
      fontWeight: "800",
      fontSize: 14,
      letterSpacing: 1.2,
      textTransform: "uppercase",
    },
    dividerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      marginVertical: spacing.sm,
    },
    dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
    dividerText: {
      color: colors.textSecondary,
      fontSize: 11,
      letterSpacing: 1.2,
      fontWeight: "700",
    },
    secondaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingVertical: 14,
      backgroundColor: "transparent",
    },
    secondaryBtnText: { color: colors.text, fontWeight: "700", fontSize: 14 },
    footNote: {
      color: colors.textDisabled,
      fontSize: 12,
      textAlign: "center",
      marginTop: spacing.md,
    },
    footNoteEm: { color: colors.text, fontWeight: "700" },
  });
};
