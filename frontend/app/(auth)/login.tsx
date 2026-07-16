import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  ImageBackground,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link, useRouter } from "expo-router";
import { colors, spacing, radius, fonts, BRAND } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";

export default function Login() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      setError("Please enter email and password");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await login(email.trim(), password);
      router.replace("/(app)");
    } catch (e: any) {
      setError(e.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ImageBackground
      source={{
        uri: "https://fourbuy.b-cdn.net/wp-content/uploads/welcome-bg.webp",
      }}
      style={styles.bg}
      imageStyle={{ opacity: 0.35 }}
    >
      <View style={styles.overlay} />
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            {/* Fourbuy Logo */}
            <View style={styles.logoBox}>
              <Image
                source={BRAND.logo}
                style={styles.logo}
                resizeMode="contain"
                accessibilityLabel="Fourbuy Car Buying Co."
              />
            </View>

            <View style={styles.divider} />

            <Text style={styles.title}>Dealer Portal</Text>
            <Text style={styles.subtitle}>Sign in to submit vehicles for pricing</Text>

            <View style={styles.field}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                testID="login-email-input"
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                placeholder="you@dealer.co.za"
                placeholderTextColor={colors.textDisabled}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Password</Text>
              <TextInput
                testID="login-password-input"
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••"
                placeholderTextColor={colors.textDisabled}
                secureTextEntry
              />
            </View>

            {error ? (
              <Text style={styles.error} testID="login-error">
                {error}
              </Text>
            ) : null}

            <TouchableOpacity
              testID="login-submit-button"
              style={[styles.primaryBtn, loading && styles.disabledBtn]}
              onPress={handleLogin}
              disabled={loading}
            >
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Sign In</Text>}
            </TouchableOpacity>

            <View style={styles.linkRow}>
              <Text style={styles.linkText}>New dealer? </Text>
              <Link href="/(auth)/register" asChild>
                <TouchableOpacity testID="go-to-register-link">
                  <Text style={styles.linkAction}>Create account</Text>
                </TouchableOpacity>
              </Link>
            </View>

            <View style={styles.hintBox}>
              <Text style={styles.hintTitle}>ADMIN DEMO CREDENTIALS</Text>
              <Text style={styles.hintText}>admin@fourbuy.co.za / admin123</Text>
            </View>

            <Text style={styles.footerTag}>{BRAND.tagline}</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: colors.bg },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(10,10,10,0.7)" },
  safe: { flex: 1 },
  scroll: { padding: spacing.lg, paddingTop: spacing.xl, flexGrow: 1 },
  logoBox: {
    alignItems: "center",
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  logo: { width: 300, height: 104 },
  subheading: {
    color: colors.textSecondary,
    fontFamily: fonts.heading,
    fontSize: 13,
    letterSpacing: 3,
    textAlign: "center",
    textTransform: "uppercase",
    fontWeight: "700",
  },
  divider: {
    alignSelf: "center",
    width: 60,
    height: 1,
    backgroundColor: colors.text,
    marginVertical: spacing.lg,
    opacity: 0.6,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 2, textTransform: "uppercase" },
  subtitle: { color: colors.textSecondary, fontSize: 14, marginBottom: spacing.xl, marginTop: 4 },
  field: { marginBottom: spacing.md },
  label: { color: colors.textSecondary, fontSize: 11, marginBottom: 6, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1 },
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
  error: { color: colors.danger, marginBottom: spacing.md, fontSize: 14 },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: spacing.md,
  },
  disabledBtn: { opacity: 0.6 },
  primaryBtnText: { color: "#000", fontWeight: "800", fontSize: 15, letterSpacing: 1.5, textTransform: "uppercase" },
  linkRow: { flexDirection: "row", justifyContent: "center", marginTop: spacing.lg },
  linkText: { color: colors.textSecondary },
  linkAction: { color: colors.primary, fontWeight: "700" },
  hintBox: {
    marginTop: spacing.xl,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  hintTitle: { color: colors.textSecondary, fontSize: 10, fontWeight: "700", marginBottom: 6, letterSpacing: 1.5 },
  hintText: { color: colors.text, fontSize: 13, fontFamily: fonts.mono },
  footerTag: {
    color: colors.textDisabled,
    fontSize: 11,
    fontFamily: fonts.serif,
    fontStyle: "italic",
    textAlign: "center",
    marginTop: spacing.xl,
    letterSpacing: 0.5,
  },
});
