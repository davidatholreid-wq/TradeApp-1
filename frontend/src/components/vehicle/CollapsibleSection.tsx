// -----------------------------------------------------------------------------
// CollapsibleSection — a lightweight header + children wrapper used across
// the valuation page to hide long-form details (AI market analysis, live
// listings, tyre estimate etc.) behind an expand/collapse chevron. Keeps
// the vertical scroll short and lets dealers reveal only the panels they
// care about.
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the P1
// modularization pass (Aug 2026). Kept intentionally style-agnostic — the
// caller passes the shared `styles` object + `colors` palette so the
// component always renders with the theme currently in scope.
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text } from "react-native";
import { Pressable } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing } from "@/src/theme";

export type CollapsibleSectionProps = {
  title: string;
  open: boolean;
  onToggle: () => void;
  right?: React.ReactNode;
  summary?: string;
  children?: React.ReactNode;
  colors: any;
  styles: any;
  testID?: string;
};

export function CollapsibleSection({
  title, open, onToggle, right, summary, children, colors, styles, testID,
}: CollapsibleSectionProps) {
  return (
    <View style={styles.collapsibleWrap} testID={testID}>
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => [
          styles.collapsibleHeader,
          pressed && { opacity: 0.85 },
        ]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "Collapse" : "Expand"} ${title}`}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.collapsibleTitle} numberOfLines={1}>{title}</Text>
          {summary && !open ? (
            <Text style={styles.collapsibleSummary} numberOfLines={1}>{summary}</Text>
          ) : null}
        </View>
        {right ? <View style={{ marginRight: spacing.sm }}>{right}</View> : null}
        <Ionicons
          name={open ? "chevron-up" : "chevron-down"}
          size={18}
          color={colors.textSecondary}
        />
      </Pressable>
      {open ? <View style={styles.collapsibleBody}>{children}</View> : null}
    </View>
  );
}

export default CollapsibleSection;
