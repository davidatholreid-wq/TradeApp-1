// -----------------------------------------------------------------------------
// CoverPlacementBar — bottom sticky bar shown to pricing agents when
// inspecting a submission in cover mode. Contains the Decline button
// (only while no cover is yet placed) and the Place/Update Cover
// button + amount input.
//
// The parent still owns the network calls (`apiFetch` POST /covers,
// POST /decline) and the confirmAsync/Alert side-effects so this
// component stays presentational.
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P3 modularization pass — Round C (Aug 2026).
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text, TextInput, ActivityIndicator } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";

export type CoverMeta = {
  my_cover: { price_zar: number; created_at: string; note?: string | null } | null;
  cover_cost_zar: number;
};

export type CoverPlacementBarProps = {
  coverMeta: CoverMeta;
  coverPriceInput: string;
  onCoverPriceChange: (raw: string) => void;
  formatMoneyString: (raw: string) => string;
  placingCover: boolean;
  decliningCover: boolean;
  onDecline: () => void;      // parent handles confirm + API + navigation
  onSubmitCover: () => void;  // parent handles confirm + API + refresh
  kbHeight: number;
  colors: any;
  styles: any;
};

export function CoverPlacementBar({
  coverMeta,
  coverPriceInput,
  onCoverPriceChange,
  formatMoneyString,
  placingCover,
  decliningCover,
  onDecline,
  onSubmitCover,
  kbHeight,
  colors,
  styles,
}: CoverPlacementBarProps) {
  return (
    <View style={[styles.coverPlaceBar, { bottom: kbHeight }]} testID="cover-place-bar">
      <View style={{ flex: 1 }}>
        {coverMeta.my_cover ? (
          <>
            <Text style={styles.coverPlacedTitle} testID="cover-placed-summary">
              Cover placed · R{coverMeta.my_cover.price_zar.toLocaleString()}
            </Text>
            <Text style={styles.coverPlacedSub}>
              Binding subject to inspection. Updates are free — the R{coverMeta.cover_cost_zar} fee was already charged on the initial cover.
            </Text>
          </>
        ) : null}
        <TextInput
          testID="cover-price-input"
          value={coverPriceInput}
          onChangeText={(t) => onCoverPriceChange(formatMoneyString(t))}
          placeholder={coverMeta.my_cover ? "Update cover (R)" : "Enter your cover (R)"}
          placeholderTextColor={colors.textDisabled}
          keyboardType="numeric"
          style={[styles.coverInput, coverMeta.my_cover && { marginTop: 6 }]}
        />
        <Text style={styles.coverBillNote}>
          {coverMeta.my_cover
            ? "Updates are free. Binding subject to inspection."
            : `R${coverMeta.cover_cost_zar} billed on submit. Binding subject to inspection.`}
        </Text>
      </View>
      <View style={styles.coverBtnRow}>
        {/* Decline — only while no cover is placed */}
        {!coverMeta.my_cover ? (
          <TouchableOpacity
            testID="cover-decline-btn"
            style={[styles.coverDeclineBtn, decliningCover && { opacity: 0.6 }]}
            disabled={placingCover || decliningCover}
            onPress={onDecline}
          >
            {decliningCover ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="close-circle" size={16} color="#fff" />
                <Text style={styles.coverDeclineBtnText}>Decline</Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          testID="cover-submit-btn"
          style={[styles.coverBtn, placingCover && { opacity: 0.6 }]}
          onPress={onSubmitCover}
          disabled={placingCover || decliningCover}
        >
          {placingCover ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.coverBtnText}>
              {coverMeta.my_cover ? "Update" : "Place Cover"}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default CoverPlacementBar;
