// -----------------------------------------------------------------------------
// ForgotPasswordScreen — enter your email to receive a magic-link reset email.
//
// The backend endpoint always responds with the same "if that email is
// registered, a reset link has been sent" message, regardless of whether the
// address actually maps to a user. This prevents email enumeration attacks
// (an attacker can't tell which addresses have accounts by watching for
// different responses). Rate limiting also lives on the backend
// (max 3 requests per email per hour).
// -----------------------------------------------------------------------------
import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { spacing, radius } from "@/src/theme";
import { darkPalette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";

export default function ForgotPasswordScreen() {
  const colors = darkPalette;
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await apiFetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      // Backend deliberately returns a generic OK even for unknown
      // emails — we show the same confirmation regardless.
      setSent(true);
    } catch (e: any) {
      // Network / server error only — the generic 200 path always
      // succeeds. Anything here means the request never landed.
      setError(e?.message || "Could not reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={["top", "left", "right", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <TouchableOpacity
              testID="forgot-back"
              onPress={() => router.back()}
              style={styles.backBtn}
              accessibilityRole="button"
              accessibilityLabel="Back to sign in"
            >
              <Ionicons name="chevron-back" size={18} color={colors.text} />
              <Text style={[styles.backText, { color: colors.text }]}>Back to sign in</Text>
            </TouchableOpacity>

            {sent ? (
              // Success state — same wording the backend uses so the
              // dealer sees a consistent message from any surface.
              <View style={styles.successBlock} testID="forgot-success">
                <View style={styles.successIcon}>
                  <Ionicons name="mail" size={26} color={colors.primary} />
                </View>
                <Text style={[styles.title, { color: colors.text }]}>Check your inbox</Text>
                <Text style={[styles.hint, { color: colors.textSecondary }]}>
                  If <Text style={{ color: colors.text, fontWeight: "700" }}>{email.trim()}</Text> is
                  registered with TradeAPP, we&apos;ve just sent a password reset link there.
                  The link is valid for 30 minutes and can only be used once.
                </Text>
                <Text style={[styles.hint, { color: colors.textSecondary, marginTop: 10 }]}>
                  Didn&apos;t get it? Check spam, or try again in a few minutes.
                </Text>
                <TouchableOpacity
                  testID="forgot-return-login"
                  style={[styles.primaryBtn, { marginTop: spacing.md }]}
                  onPress={() => router.replace("/(auth)/login")}
                >
                  <Text style={styles.primaryBtnText}>Back to sign in</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={[styles.title, { color: colors.text }]}>Forgot your password?</Text>
                <Text style={[styles.hint, { color: colors.textSecondary }]}>
                  Enter the email you use to sign in and we&apos;ll send you a link to reset it.
                </Text>

                <View style={styles.field}>
                  <Text style={[styles.label, { color: colors.textSecondary }]}>EMAIL</Text>
                  <TextInput
                    testID="forgot-email-input"
                    value={email}
                    onChangeText={(v) => {
                      setEmail(v);
                      if (error) setError(null);
                    }}
                    placeholder="you@dealer.co.za"
                    placeholderTextColor={colors.textDisabled}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    returnKeyType="send"
                    onSubmitEditing={handleSubmit}
                    style={[
                      styles.input,
                      { color: colors.text, backgroundColor: colors.card, borderColor: colors.border },
                    ]}
                  />
                </View>

                {error ? (
                  <View style={styles.errorRow} testID="forgot-error">
                    <Ionicons name="alert-circle" size={16} color={colors.danger} />
                    <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
                  </View>
                ) : null}

                <TouchableOpacity
                  testID="forgot-submit"
                  style={[styles.primaryBtn, loading && { opacity: 0.6 }]}
                  onPress={handleSubmit}
                  disabled={loading}
                >
                  {loading ? (
                    <ActivityIndicator color={colors.onPrimary} />
                  ) : (
                    <Text style={styles.primaryBtnText}>Send reset link</Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: {
    flexGrow: 1,
    padding: spacing.lg,
    justifyContent: "center",
    alignItems: "center",
  },
  card: {
    width: "100%",
    maxWidth: 460,
    backgroundColor: darkPalette.paper,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: darkPalette.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    padding: 4,
    marginBottom: 4,
  },
  backText: { fontSize: 12, fontWeight: "700" },
  title: { fontSize: 22, fontWeight: "900", letterSpacing: -0.3 },
  hint: { fontSize: 13, lineHeight: 18 },
  field: { gap: 6 },
  label: { fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  input: {
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "web" ? 12 : 10,
    fontSize: 14,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" as any } as any) : {}),
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
  errorText: { fontSize: 13, flex: 1 },
  primaryBtn: {
    backgroundColor: darkPalette.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: "center",
    alignSelf: "stretch",
    minWidth: 180,
  },
  primaryBtnText: {
    color: darkPalette.onPrimary,
    fontWeight: "800",
    fontSize: 13,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  successBlock: { gap: 6, alignItems: "stretch" },
  successIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: darkPalette.primary + "22",
    borderWidth: 1,
    borderColor: darkPalette.primary + "66",
    marginBottom: 6,
  },
});
