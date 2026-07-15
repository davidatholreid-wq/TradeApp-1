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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "@/src/theme";
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
        uri: "https://images.unsplash.com/photo-1565043666747-69f6646db940?crop=entropy&cs=srgb&fm=jpg&w=800&q=60",
      }}
      style={styles.bg}
      imageStyle={{ opacity: 0.25 }}
    >
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.brandRow}>
              <View style={styles.logoBox}>
                <Ionicons name="car-sport" size={32} color={colors.primary} />
              </View>
              <Text style={styles.brand}>AutoPricePro</Text>
            </View>

            <Text style={styles.title}>Welcome back</Text>
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
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>Sign In</Text>
              )}
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
              <Text style={styles.hintTitle}>Admin demo credentials</Text>
              <Text style={styles.hintText}>admin@autopricepro.com / admin123</Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: colors.bg },
  safe: { flex: 1 },
  scroll: { padding: spacing.lg, paddingTop: spacing.xl, flexGrow: 1 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: spacing.xl },
  logoBox: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  brand: { color: colors.text, fontSize: 20, fontWeight: "800", letterSpacing: 0.5 },
  title: { color: colors.text, fontSize: 32, fontWeight: "800", marginBottom: spacing.xs },
  subtitle: { color: colors.textSecondary, fontSize: 15, marginBottom: spacing.xl },
  field: { marginBottom: spacing.md },
  label: { color: colors.textSecondary, fontSize: 13, marginBottom: 6, fontWeight: "500" },
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
    borderRadius: radius.pill,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: spacing.md,
  },
  disabledBtn: { opacity: 0.6 },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  linkRow: { flexDirection: "row", justifyContent: "center", marginTop: spacing.lg },
  linkText: { color: colors.textSecondary },
  linkAction: { color: colors.primary, fontWeight: "600" },
  hintBox: {
    marginTop: spacing.xl,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
  },
  hintTitle: { color: colors.textSecondary, fontSize: 12, fontWeight: "600", marginBottom: 4 },
  hintText: { color: colors.text, fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
});
