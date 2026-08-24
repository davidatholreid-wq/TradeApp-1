import { useState, useMemo } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, Modal, ScrollView, ActivityIndicator, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts, BRAND } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";
import { useAuth } from "@/src/context/AuthContext";

/**
 * One-time Pricing Agreement modal shown to dealers on first login.
 *
 * Blocks the rest of the app until the dealer explicitly accepts. Once the
 * `/api/agreement/accept` call succeeds, the parent `AuthContext` user is
 * mutated so the modal never shows again for that session.
 */
export default function AgreementModal() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { user, markAgreementAccepted, logout } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only shows for logged-in DEALERS who haven't accepted.
  const shouldShow = !!user && user.role === "dealer" && !user.agreement_accepted_at;

  const accept = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/agreement/accept", { method: "POST" });
      markAgreementAccepted(res.accepted_at);
    } catch (e: any) {
      setError(e?.message || "Could not accept agreement");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={shouldShow}
      animationType="fade"
      transparent
      onRequestClose={() => {
        /* not dismissible */
      }}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Ionicons name="shield-checkmark" size={22} color={colors.neon} />
            <Text style={styles.title}>TradeAPP Pricing Agreement</Text>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: spacing.md }}>
            <Text style={styles.paragraph}>
              Welcome to <Text style={styles.brand}>{BRAND.name}</Text>. Before you
              submit vehicles for pricing, please review and accept the terms below.
            </Text>

            <View style={styles.termsBox}>
              <Text style={styles.termHeading}>Pricing fee</Text>
              <Text style={styles.term}>
                • A fee of{" "}
                <Text style={styles.strong}>R50 (fifty Rand) including VAT</Text>{" "}
                is charged for every vehicle that we PRICE for you.
              </Text>

              <Text style={styles.termHeading}>24-hour guarantee</Text>
              <Text style={styles.term}>
                • If we do NOT return a price to you within{" "}
                <Text style={styles.strong}>24 hours</Text> of your submission, the
                fee is <Text style={styles.strong}>waived</Text> — no charge to you.
              </Text>

              <Text style={styles.termHeading}>Billing</Text>
              <Text style={styles.term}>
                • Fees accumulate per calendar month and are invoiced separately by
                TradeAPP. Payment is by EFT.
              </Text>
              <Text style={styles.term}>
                • Unpaid accounts may be suspended until settled.
              </Text>

              <Text style={styles.termHeading}>Confirmation on every submission</Text>
              <Text style={styles.term}>
                • Each vehicle you submit will show a confirmation reminding you of
                the R50 fee. You may cancel any submission before confirming.
              </Text>
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity
              testID="agreement-decline"
              style={styles.declineBtn}
              onPress={() => logout()}
              disabled={submitting}
            >
              <Text style={styles.declineText}>Decline & Sign out</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="agreement-accept"
              style={[styles.acceptBtn, submitting && { opacity: 0.6 }]}
              onPress={accept}
              disabled={submitting}
              activeOpacity={0.85}
            >
              {submitting ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <>
                  <Ionicons name="checkmark" size={18} color={colors.onPrimary} />
                  <Text style={styles.acceptText}>I Accept</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  card: {
    width: "100%",
    maxWidth: 480,
    maxHeight: "90%",
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.neon + "88",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.paper,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  body: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  paragraph: { color: colors.text, fontSize: 14, lineHeight: 21, marginBottom: spacing.md },
  brand: { color: colors.text, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 1.5, textTransform: "uppercase" },
  termsBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    backgroundColor: colors.paper,
    marginBottom: spacing.md,
  },
  termHeading: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginTop: 12,
    marginBottom: 6,
  },
  term: { color: colors.text, fontSize: 13, lineHeight: 20 },
  strong: { color: colors.neon, fontWeight: "800" },
  error: { color: colors.danger, fontSize: 13, marginBottom: 8, textAlign: "center" },
  footer: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.paper,
  },
  declineBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    backgroundColor: colors.card,
  },
  declineText: { color: colors.textSecondary, fontWeight: "700", fontSize: 13, letterSpacing: 0.5 },
  acceptBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    ...(Platform.OS !== "android"
      ? { shadowColor: colors.neon, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 8 }
      : {}),
  },
  acceptText: { color: colors.onPrimary, fontWeight: "800", fontSize: 14, letterSpacing: 1, textTransform: "uppercase" },
});
