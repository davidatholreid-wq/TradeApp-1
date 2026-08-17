/**
 * EditResubmitCard
 * -----------------------------------------------------------------------------
 * Dealer-only card inside the vehicle detail screen (Aug 2026).
 *
 * Lets a dealer retract a priced valuation within the 14-day window since
 * `priced_at` and re-submit it with edited details. Renders a
 * state-aware warning message when the vehicle is currently in Stock or
 * carries a deal outcome so the dealer understands the side-effects
 * BEFORE tapping through to the Submit form. Sold stock is a hard-stop
 * — the button is disabled with an explanation and the caller (backend)
 * enforces the same rule.
 */
import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { useThemeColors } from "@/src/theme/ThemeContext";
import { spacing, radius, fonts } from "@/src/theme";

// Must match backend RESUBMIT_WINDOW_DAYS.
export const RESUBMIT_WINDOW_DAYS = 14;

export type ResubmitPromptReason =
  | { kind: "clean" }
  | { kind: "in_stock"; stockNumber?: string | null; sold?: boolean }
  | { kind: "deal_done" }
  | { kind: "no_deal" };

export type ResubmitPromptState = {
  canResubmit: boolean;
  reason: ResubmitPromptReason;
  disabledReason?: string;
};

/**
 * Evaluate a submission and return whether Edit & Re-submit is allowed
 * plus the extra warning copy to render. Pure — exported so the vehicle
 * detail screen can pass the resulting message straight into a native
 * `Alert.alert` / web `window.confirm` prompt.
 */
export function evaluateResubmitState(sub: any | null | undefined): ResubmitPromptState {
  if (!sub) return { canResubmit: false, reason: { kind: "clean" }, disabledReason: "Loading valuation…" };
  if (sub.retracted) {
    return { canResubmit: false, reason: { kind: "clean" }, disabledReason: "This valuation has already been retracted." };
  }
  if (sub.status !== "priced" || !sub.priced_at) {
    return { canResubmit: false, reason: { kind: "clean" }, disabledReason: "Only priced valuations can be re-submitted." };
  }
  const pricedAt = new Date(sub.priced_at).getTime();
  if (isNaN(pricedAt)) {
    return { canResubmit: false, reason: { kind: "clean" }, disabledReason: "Priced-at timestamp is invalid." };
  }
  const ageDays = (Date.now() - pricedAt) / (1000 * 60 * 60 * 24);
  if (ageDays < 0 || ageDays > RESUBMIT_WINDOW_DAYS) {
    return {
      canResubmit: false,
      reason: { kind: "clean" },
      disabledReason: `The 14-day re-submit window has passed for this valuation.`,
    };
  }
  // In-stock check comes before deal-outcome because it's the strongest
  // side-effect the dealer needs to know about. Sold stock is enforced
  // server-side (POST /resubmit returns 409), so we don't need to
  // hydrate the stock item here — the alert on 409 handles that edge.
  const stockItemId = sub.stock_item_id || null;
  const stockNumber = sub.stock_number || null;
  if (stockItemId) {
    return { canResubmit: true, reason: { kind: "in_stock", stockNumber, sold: false } };
  }
  const dealDone = sub?.deal?.done;
  if (dealDone === true) return { canResubmit: true, reason: { kind: "deal_done" } };
  if (dealDone === false) return { canResubmit: true, reason: { kind: "no_deal" } };
  return { canResubmit: true, reason: { kind: "clean" } };
}

/**
 * Build the confirmation copy that goes into the native Alert / web
 * confirm. The extra sentence at the top is tailored to whichever state
 * the vehicle is currently in.
 */
export function buildResubmitConfirmMessage(sub: any, state: ResubmitPromptState): string {
  const ref = sub?.reference || "this valuation";
  const base =
    `This will retract ${ref} and open a new editable version with all details pre-filled.\n\n` +
    `You'll still be charged R50 once Fourbuy prices the new valuation.`;
  switch (state.reason.kind) {
    case "in_stock": {
      const stk = state.reason.stockNumber ? ` (${state.reason.stockNumber})` : "";
      return (
        `This vehicle is currently in your Stock list${stk}.\n\n` +
        `Continuing will REMOVE it from Stock and create a new pending submission for editing. ` +
        base
      );
    }
    case "deal_done":
      return (
        `This vehicle is marked as DEAL DONE.\n\n` +
        `Continuing will void that outcome (via retract) and create a new pending submission for editing. ` +
        base
      );
    case "no_deal":
      return (
        `This vehicle is marked as NO DEAL.\n\n` +
        `Continuing will void that outcome (via retract) and create a new pending submission for editing. ` +
        base
      );
    default:
      return `${base}\n\nContinue?`;
  }
}

export default function EditResubmitCard({
  sub,
  onResubmit,
}: {
  sub: any;
  onResubmit: () => void;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const state = useMemo(() => evaluateResubmitState(sub), [sub]);

  // Hide entirely when the vehicle is out of window / already retracted —
  // no point rendering a permanently-disabled card in that case. When
  // it IS re-submittable, we show the card with either the neutral or
  // the state-aware warning tone.
  if (!state.canResubmit) return null;

  // State-aware sub-heading rendered under the title on the card body.
  let subHeading = "Retract this valuation and re-open it as a new editable version.";
  if (state.reason.kind === "in_stock" && !state.reason.sold) {
    subHeading = "This vehicle is in your Stock list — continuing will remove it from Stock.";
  } else if (state.reason.kind === "in_stock" && state.reason.sold) {
    subHeading = "This vehicle has already been sold from stock and can no longer be re-submitted.";
  } else if (state.reason.kind === "deal_done") {
    subHeading = "This vehicle is flagged Deal Done — continuing will void that outcome.";
  } else if (state.reason.kind === "no_deal") {
    subHeading = "This vehicle is flagged No Deal — continuing will void that outcome.";
  }

  const warningTone =
    state.reason.kind === "in_stock" || state.reason.kind === "deal_done" || state.reason.kind === "no_deal";

  return (
    <View style={[styles.card, warningTone ? styles.cardWarning : null]} testID="edit-resubmit-card">
      <View style={styles.headerRow}>
        <View style={[styles.iconBubble, warningTone ? styles.iconBubbleWarning : null]}>
          <Ionicons
            name={warningTone ? "warning-outline" : "create-outline"}
            size={18}
            color={warningTone ? "#78350F" : colors.primary}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, warningTone ? styles.titleWarning : null]}>
            EDIT &amp; RE-SUBMIT
          </Text>
          <Text style={[styles.sub, warningTone ? styles.subWarning : null]}>{subHeading}</Text>
        </View>
      </View>

      <TouchableOpacity
        testID="edit-resubmit-button"
        style={[styles.button, !state.canResubmit ? styles.buttonDisabled : null]}
        onPress={onResubmit}
        disabled={!state.canResubmit}
      >
        <Ionicons
          name="refresh"
          size={16}
          color={state.canResubmit ? "#fff" : colors.textSecondary}
        />
        <Text style={[styles.buttonText, !state.canResubmit ? styles.buttonTextDisabled : null]}>
          {state.canResubmit ? "Edit & Re-submit" : (state.disabledReason || "Not available")}
        </Text>
      </TouchableOpacity>

      <Text style={styles.footnote}>
        R50 will apply once Fourbuy prices the new version, on top of any R50 already invoiced.
      </Text>
    </View>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    card: {
      marginTop: spacing.md,
      marginHorizontal: spacing.md,
      padding: spacing.md,
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.borderLight,
    },
    cardWarning: {
      borderColor: "#F59E0B",
      backgroundColor: "#FEF3C7" + "55",
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      marginBottom: spacing.md,
    },
    iconBubble: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.primary + "18",
      alignItems: "center",
      justifyContent: "center",
    },
    iconBubbleWarning: {
      backgroundColor: "#F59E0B" + "22",
    },
    title: {
      color: colors.text,
      fontSize: 12,
      fontWeight: "800",
      letterSpacing: 0.6,
      fontFamily: fonts.body,
    },
    sub: {
      color: colors.textSecondary,
      fontSize: 12,
      marginTop: 2,
      lineHeight: 16,
    },
    // Darker amber palette for the warning tone so the sub-heading and
    // title reach AA contrast (≥4.5:1) on top of the amber tinted card
    // background. #78350F (Tailwind amber-900) sits comfortably above
    // the AA threshold on both #FEF3C7 and the semi-transparent tint.
    titleWarning: {
      color: "#78350F",
    },
    subWarning: {
      color: "#78350F",
    },
    button: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 12,
      paddingHorizontal: spacing.md,
      backgroundColor: colors.primary,
      borderRadius: radius.md,
    },
    buttonDisabled: {
      backgroundColor: colors.borderLight,
    },
    buttonText: {
      color: "#fff",
      fontSize: 14,
      fontWeight: "800",
      letterSpacing: 0.3,
    },
    buttonTextDisabled: {
      color: colors.textSecondary,
      fontWeight: "700",
      fontSize: 12,
      textAlign: "center",
    },
    footnote: {
      color: colors.textSecondary,
      fontSize: 11,
      marginTop: spacing.sm,
      textAlign: "center",
      lineHeight: 15,
    },
  });
