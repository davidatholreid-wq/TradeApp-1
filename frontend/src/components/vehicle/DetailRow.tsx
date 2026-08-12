// -----------------------------------------------------------------------------
// DetailRow — a single "label: value" line inside the vehicle detail
// modal cards. Handles optional colouring (used for green/red status
// indicators like "Active" / "Expired") and monospaced number formatting.
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P1 modularization pass (Aug 2026). Uses the shared vehicle-detail
// stylesheet so the row always matches the rest of the surface.
// -----------------------------------------------------------------------------
import { useMemo } from "react";
import { View, Text } from "react-native";
import { fonts } from "@/src/theme";
import { useThemeColors } from "@/src/theme/ThemeContext";
import { makeStyles } from "@/src/styles/vehicleDetailStyles";

export type DetailRowProps = {
  label: string;
  value: string;
  valueColor?: string;
  last?: boolean;
  mono?: boolean;
};

export function DetailRow({ label, value, valueColor, last, mono }: DetailRowProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.detailRow, last && { borderBottomWidth: 0 }]}>
      <Text style={styles.detailRowLabel}>{label}:</Text>
      <Text
        style={[
          styles.detailRowValue,
          mono && { fontFamily: fonts.mono, letterSpacing: 0.5 },
          valueColor ? { color: valueColor } : null,
        ]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

export default DetailRow;
