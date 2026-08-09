// -----------------------------------------------------------------------------
// ResetPasswordScreen — landing page for the magic link in the reset email.
//
// URL: /reset-password?token=<jwt>
//   • The token is a short-lived (30 min), single-use JWT issued by
//     POST /api/auth/forgot-password.
//   • The screen validates the token client-side only for expiry hints; the
//     real enforcement is server-side via POST /api/auth/reset-password.
//   • On success we bounce back to the sign-in screen with a confirmation.
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
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { spacing, radius } from "@/src/theme";
import { darkPalette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";

export default function ResetPasswordScreen() {
  const colors = darkPalette;
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const token = (params?.token || "").toString();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const hasToken = token.length > 0;

  const handleSubmit = async () => {
    if (!hasToken) {
      setError("This reset link is missing its token. Please open the link from your email again.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await apiFetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, new_password: password }),
      });
      setDone(true);
    } catch (e: any) {
      // apiFetch surfaces { detail: "..." } from the backend as the
      // error message — that's already user-friendly ("This reset
      // link has expired.", "This reset link has already been used.")
      setError(e?.message || "Could not reset your password. Please try again.");
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
            {done ? (
              <View style={styles.successBlock} testID="reset-success">
                <View style={styles.successIcon}>
                  <Ionicons name="checkmark-circle" size={30} color={colors.success} />
                </View>
                <Text style={[styles.title, { color: colors.text }]}>Password updated</Text>
                <Text style={[styles.hint, { color: colors.textSecondary }]}>
                  You can now sign in with your new password.
                </Text>
                <TouchableOpacity
                  testID="reset-goto-login"
                  style={[styles.primaryBtn, { marginTop: spacing.md }]}
                  onPress={() => router.replace("/(auth)/login")}
                >
                  <Text style={styles.primaryBtnText}>Sign in</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={[styles.title, { color: colors.text }]}>Choose a new password</Text>
                <Text style={[styles.hint, { color: colors.textSecondary }]}>
                  Enter your new password below. It must be at least 6 characters.
                </Text>

                {!hasToken ? (
                  <View style={styles.errorRow} testID="reset-missing-token">
                    <Ionicons name="alert-circle" size={16} color={colors.danger} />
                    <Text style={[styles.errorText, { color: colors.danger }]}>
                      This reset link is missing its token. Please open the link from your email again.
                    </Text>
                  </View>
                ) : null}

                <View style={styles.field}>
                  <View style={styles.labelRow}>
                    <Text style={[styles.label, { color: colors.textSecondary }]}>NEW PASSWORD</Text>
                    <TouchableOpacity onPress={() => setShowPassword((s) => !s)} accessibilityRole="button">
                      <Text style={[styles.labelAction, { color: colors.primary }]}>
                        {showPassword ? "Hide" : "Show"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    testID="reset-password-input"
                    value={password}
                    onChangeText={(v) => {
                      setPassword(v);
                      if (error) setError(null);
                    }}
                    placeholder="At least 6 characters"
                    placeholderTextColor={colors.textDisabled}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry={!showPassword}
                    returnKeyType="next"
                    style={[
                      styles.input,
                      { color: colors.text, backgroundColor: colors.card, borderColor: colors.border },
                    ]}
                  />
                </View>

                <View style={styles.field}>
                  <Text style={[styles.label, { color: colors.textSecondary }]}>CONFIRM PASSWORD</Text>
                  <TextInput
                    testID="reset-confirm-input"
                    value={confirmPassword}
                    onChangeText={(v) => {
                      setConfirmPassword(v);
                      if (error) setError(null);
                    }}
                    placeholder="Re-enter password"
                    placeholderTextColor={colors.textDisabled}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry={!showPassword}
                    returnKeyType="go"
                    onSubmitEditing={handleSubmit}
                    style={[
                      styles.input,
                      { color: colors.text, backgroundColor: colors.card, borderColor: colors.border },
                    ]}
                  />
                </View>

                {error ? (
                  <View style={styles.errorRow} testID="reset-error">
                    <Ionicons name="alert-circle" size={16} color={colors.danger} />
                    <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
                  </View>
                ) : null}

                <TouchableOpacity
                  testID="reset-submit"
                  style={[styles.primaryBtn, loading && { opacity: 0.6 }]}
                  onPress={handleSubmit}
                  disabled={loading || !hasToken}
                >
                  {loading ? (
                    <ActivityIndicator color={colors.onPrimary} />
                  ) : (
                    <Text style={styles.primaryBtnText}>Update password</Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  testID="reset-cancel"
                  onPress={() => router.replace("/(auth)/login")}
                  style={styles.cancelBtn}
                  accessibilityRole="link"
                >
                  <Text style={[styles.cancelText, { color: colors.textSecondary }]}>
                    Cancel — back to sign in
                  </Text>
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
  title: { fontSize: 22, fontWeight: "900", letterSpacing: -0.3 },
  hint: { fontSize: 13, lineHeight: 18 },
  field: { gap: 6 },
  labelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  labelAction: { fontSize: 12, fontWeight: "700" },
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
    alignItems: "center",
  },
  primaryBtnText: {
    color: darkPalette.onPrimary,
    fontWeight: "800",
    fontSize: 13,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  cancelBtn: { alignItems: "center", paddingVertical: 6 },
  cancelText: { fontSize: 12, fontWeight: "700", textDecorationLine: "underline" },
  successBlock: { gap: 6, alignItems: "flex-start" },
  successIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: darkPalette.success + "22",
    borderWidth: 1,
    borderColor: darkPalette.success + "66",
    marginBottom: 6,
  },
});
