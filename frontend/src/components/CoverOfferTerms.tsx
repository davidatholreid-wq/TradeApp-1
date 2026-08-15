/**
 * CoverOfferTermsModal + CoverOfferTermsButton
 *
 * A single self-contained pair that surfaces the Fourbuy Subject to
 * View Cover Offer T&Cs anywhere they're relevant — vehicle detail,
 * Give Cover screen, admin, etc.
 *
 * Usage:
 *   import { CoverOfferTermsButton } from "@/src/components/CoverOfferTerms";
 *   ...
 *   <CoverOfferTermsButton />
 *
 * Or drive the modal directly:
 *   const [open, setOpen] = useState(false);
 *   <CoverOfferTermsModal visible={open} onClose={() => setOpen(false)} />
 */

import { useState, useMemo } from "react";
import {
  View,
  Text,
  Modal,
  ScrollView,
  StyleSheet,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";

import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { spacing, radius } from "@/src/theme";
import {
  COVER_OFFER_TERMS_TITLE,
  COVER_OFFER_TERMS_SUBTITLE,
  COVER_OFFER_TERMS_LAST_REV,
  COVER_OFFER_TERMS_SECTIONS,
  COVER_OFFER_ACCEPTANCE_DECLARATION,
} from "@/src/constants/coverOfferTerms";

// ---------------------------------------------------------------------------
// Modal — full-screen sheet on native, centered card on wide web viewports.
// ---------------------------------------------------------------------------
export function CoverOfferTermsModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <SafeAreaView style={styles.sheet} edges={["top", "bottom"]}>
          {/* Header */}
          <View style={styles.header}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {COVER_OFFER_TERMS_TITLE}
              </Text>
              <Text style={styles.headerSubtitle}>{COVER_OFFER_TERMS_SUBTITLE}</Text>
            </View>
            <TouchableOpacity
              testID="cover-terms-modal-close"
              onPress={onClose}
              style={styles.closeBtn}
              accessibilityLabel="Close terms and conditions"
            >
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          {/* Body — scrollable clauses */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.body}
            showsVerticalScrollIndicator
          >
            {COVER_OFFER_TERMS_SECTIONS.map((s, idx) => (
              <View key={`${s.n}-${idx}`} style={{ marginBottom: spacing.md }}>
                {s.heading ? (
                  <Text style={styles.sectionHeading}>
                    {s.n.includes("cont") ? "" : `${s.n}. `}
                    {s.heading}
                  </Text>
                ) : null}
                {s.paragraphs?.map((p, i) => (
                  <Text key={`p-${i}`} style={styles.paragraph}>
                    {p}
                  </Text>
                ))}
                {s.bullets?.length ? (
                  <View style={styles.bulletBlock}>
                    {s.bullets.map((b, i) => (
                      <View key={`b-${i}`} style={styles.bulletRow}>
                        <Text style={styles.bulletDot}>•</Text>
                        <Text style={styles.bulletText}>{b}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            ))}

            {/* Acceptance declaration — highlighted */}
            <View style={styles.acceptanceBox}>
              <Text style={styles.acceptanceTitle}>Acceptance Declaration</Text>
              <Text style={styles.acceptanceBody}>
                {COVER_OFFER_ACCEPTANCE_DECLARATION}
              </Text>
            </View>

            <Text style={styles.footerNote}>
              Last revised: {COVER_OFFER_TERMS_LAST_REV} · Fourbuy Car Buying Co.
            </Text>
          </ScrollView>

          {/* Sticky footer close button */}
          <View style={styles.footer}>
            <TouchableOpacity
              testID="cover-terms-modal-done"
              onPress={onClose}
              style={styles.doneBtn}
              activeOpacity={0.85}
            >
              <Text style={styles.doneBtnTxt}>Done</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Button — small inline "Terms & Conditions of Offer" pill. Manages its own
// modal state so callers can just drop it wherever they show a cover.
// ---------------------------------------------------------------------------
export function CoverOfferTermsButton({
  label = "Terms & Conditions of Offer",
  compact = false,
  style,
}: {
  label?: string;
  compact?: boolean;
  style?: any;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);

  return (
    <>
      <TouchableOpacity
        testID="cover-terms-button"
        onPress={() => setOpen(true)}
        activeOpacity={0.85}
        style={[compact ? styles.btnCompact : styles.btn, style]}
      >
        <Ionicons
          name="document-text-outline"
          size={compact ? 13 : 15}
          color={colors.primary}
        />
        <Text style={[compact ? styles.btnCompactTxt : styles.btnTxt, { color: colors.primary }]}>
          {label}
        </Text>
      </TouchableOpacity>
      <CoverOfferTermsModal visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "flex-end",
      ...(Platform.OS === "web" && { justifyContent: "center", alignItems: "center" }),
    },
    sheet: {
      backgroundColor: colors.bg,
      width: "100%" as const,
      ...(Platform.OS === "web" && { maxWidth: 780 as any, maxHeight: "92%" as any, borderRadius: radius.lg }),
      // Native full-screen sheet — round the top corners only.
      ...(Platform.OS !== "web" && { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg }),
      flex: Platform.OS === "web" ? undefined : 1,
      overflow: "hidden" as const,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: 8,
    },
    headerTitle: {
      color: colors.text,
      fontSize: 17,
      fontWeight: "800",
      letterSpacing: -0.2,
    },
    headerSubtitle: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: "600",
      marginTop: 2,
    },
    closeBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 16,
      backgroundColor: colors.card,
    },
    body: {
      padding: spacing.md,
      paddingBottom: spacing.lg,
    },
    sectionHeading: {
      color: colors.text,
      fontSize: 14,
      fontWeight: "800",
      letterSpacing: 0.3,
      textTransform: "uppercase" as const,
      marginBottom: 6,
    },
    paragraph: {
      color: colors.text,
      fontSize: 13,
      lineHeight: 19,
      marginBottom: 6,
    },
    bulletBlock: {
      marginTop: 4,
      marginBottom: 4,
      paddingLeft: 6,
    },
    bulletRow: {
      flexDirection: "row",
      gap: 8,
      marginBottom: 4,
    },
    bulletDot: {
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      width: 12,
    },
    bulletText: {
      flex: 1,
      color: colors.text,
      fontSize: 13,
      lineHeight: 19,
    },
    acceptanceBox: {
      marginTop: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: colors.primary + "14",
      borderWidth: 1,
      borderColor: colors.primary + "55",
    },
    acceptanceTitle: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: "800",
      letterSpacing: 0.8,
      textTransform: "uppercase" as const,
      marginBottom: 6,
    },
    acceptanceBody: {
      color: colors.text,
      fontSize: 13,
      lineHeight: 20,
    },
    footerNote: {
      color: colors.textSecondary,
      fontSize: 11,
      marginTop: spacing.md,
      textAlign: "center" as const,
    },
    footer: {
      padding: spacing.md,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.bg,
    },
    doneBtn: {
      backgroundColor: colors.primary,
      borderRadius: radius.md,
      paddingVertical: 12,
      alignItems: "center",
    },
    doneBtnTxt: {
      color: colors.onPrimary,
      fontSize: 15,
      fontWeight: "800",
      letterSpacing: 0.4,
    },

    // ----- Trigger buttons -----
    btn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start" as const,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.primary + "77",
      backgroundColor: colors.primary + "14",
    },
    btnTxt: {
      fontSize: 12,
      fontWeight: "800",
      letterSpacing: 0.3,
    },
    btnCompact: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      alignSelf: "flex-start" as const,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.primary + "55",
      backgroundColor: "transparent",
    },
    btnCompactTxt: {
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 0.2,
    },
  });

export default CoverOfferTermsButton;
