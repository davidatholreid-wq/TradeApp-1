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
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, fonts, BRAND } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";

export default function Register() {
  const { register } = useAuth();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isWide = width >= 768;
  const [form, setForm] = useState({
    email: "",
    password: "",
    first_name: "",
    last_name: "",
    phone: "",
    company_name: "",
    company_address: "",
    company_reg_no: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleRegister = async () => {
    const required = ["email", "password", "first_name", "last_name", "phone", "company_name", "company_address"];
    for (const k of required) {
      if (!form[k as keyof typeof form].trim()) {
        setError(`${k.replace("_", " ")} is required`);
        return;
      }
    }
    if (form.password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await register({
        email: form.email.trim(),
        password: form.password,
        dealer_info: {
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          phone: form.phone.trim(),
        },
        company_info: {
          company_name: form.company_name.trim(),
          company_address: form.company_address.trim(),
          company_reg_no: form.company_reg_no.trim() || undefined,
        },
      });
      router.replace("/(app)");
    } catch (e: any) {
      setError(e.message || "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  const renderField = (label: string, key: keyof typeof form, opts: any = {}) => (
    <View style={styles.field} key={key}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        testID={`register-${key}-input`}
        style={styles.input}
        value={form[key]}
        onChangeText={(t) => update(key, t)}
        placeholderTextColor={colors.textDisabled}
        {...opts}
      />
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View style={styles.header}>
          <TouchableOpacity testID="register-back-button" onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Create Account</Text>
        </View>
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            isWide && styles.scrollWide,
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.card, isWide && styles.cardWide]}>
          <Text style={styles.title}>Dealer Registration</Text>
          <Text style={styles.subtitle}>Register your dealership with {BRAND.short}</Text>

          <Text style={styles.sectionTitle}>Account</Text>
          {renderField("Email", "email", { autoCapitalize: "none", keyboardType: "email-address" })}
          {renderField("Password", "password", { secureTextEntry: true })}

          <Text style={styles.sectionTitle}>Personal Information</Text>
          {renderField("First Name", "first_name")}
          {renderField("Last Name", "last_name")}
          {renderField("Phone", "phone", { keyboardType: "phone-pad" })}

          <Text style={styles.sectionTitle}>Company Information</Text>
          {renderField("Company Name", "company_name")}
          {renderField("Company Address", "company_address", { multiline: true })}
          {renderField("Company Reg No. (optional)", "company_reg_no")}

          {error ? (
            <Text style={styles.error} testID="register-error">
              {error}
            </Text>
          ) : null}

          <TouchableOpacity
            testID="register-submit-button"
            style={[styles.primaryBtn, loading && styles.disabledBtn]}
            onPress={handleRegister}
            disabled={loading}
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Create Account</Text>}
          </TouchableOpacity>

          <View style={styles.linkRow}>
            <Text style={styles.linkText}>Already registered? </Text>
            <Link href="/(auth)/login" asChild>
              <TouchableOpacity testID="go-to-login-link">
                <Text style={styles.linkAction}>Sign in</Text>
              </TouchableOpacity>
            </Link>
          </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.paper,
  },
  backBtn: { padding: spacing.xs, marginRight: spacing.sm },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  scrollWide: {
    alignItems: "center",
    paddingVertical: spacing.xl,
  },
  card: { width: "100%" },
  cardWide: {
    maxWidth: 560,
    width: "100%",
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: "800", fontFamily: fonts.heading, marginBottom: 4, letterSpacing: 2, textTransform: "uppercase" },
  subtitle: { color: colors.textSecondary, fontSize: 14, marginBottom: spacing.lg },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  field: { marginBottom: spacing.sm },
  label: { color: colors.textSecondary, fontSize: 13, marginBottom: 6 },
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
  error: { color: colors.danger, marginTop: spacing.sm, fontSize: 14 },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: spacing.lg,
  },
  disabledBtn: { opacity: 0.6 },
  primaryBtnText: { color: "#000", fontWeight: "800", fontSize: 15, letterSpacing: 1.5, textTransform: "uppercase" },
  linkRow: { flexDirection: "row", justifyContent: "center", marginTop: spacing.lg },
  linkText: { color: colors.textSecondary },
  linkAction: { color: colors.primary, fontWeight: "600" },
});
