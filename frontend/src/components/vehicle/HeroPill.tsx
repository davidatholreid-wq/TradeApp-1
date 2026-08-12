// -----------------------------------------------------------------------------
// HeroPill — the "X/10" score chip rendered along the hero row for the
// four condition pillars (mechanical, cosmetic, interior, history).
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P1 modularization pass (Aug 2026).
// -----------------------------------------------------------------------------
import { useMemo } from "react";
import { View, Text } from "react-native";
import { useThemeColors } from "@/src/theme/ThemeContext";
import { makeStyles } from "@/src/styles/vehicleDetailStyles";

export type HeroPillProps = { label: string; value?: number };

export function HeroPill({ label, value }: HeroPillProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.heroPill}>
      <Text style={styles.heroPillLabel}>{label}</Text>
      <Text style={styles.heroPillValue}>{value ? `${value}/10` : "—"}</Text>
    </View>
  );
}

export default HeroPill;
