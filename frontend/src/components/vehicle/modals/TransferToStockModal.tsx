// -----------------------------------------------------------------------------
// TransferToStockModal — one-time capture of stock_number + target
// selling price at transfer time.
//
// Kept intentionally minimal: the entire premise of the Aug 2026 stock
// rework is that transfer should be a SINGLE, LOW-FRICTION action.
// Anything else the dealer wants to correct on the vehicle (mileage,
// colour, VIN, condition score…) can be edited later inside the stock
// module itself.
// -----------------------------------------------------------------------------
import React, { useCallback, useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  Platform,
  Alert,
  ScrollView,
} from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";

export type TransferToStockModalProps = {
  visible: boolean;
  onClose: () => void;
  onSubmit: (payload: { stock_number: string; target_sell_price_zar: number }) => Promise<void> | void;
  // Vehicle summary shown at the top of the modal so the user
  // confirms they're transferring the right car.
  vehicleTitle: string;
  vehicleSubtitle?: string | null;
  // Pre-fill hint (e.g. suggested target based on Fourbuy cover), or
  // leave undefined to start blank.
  suggestedTargetZar?: number | null;
  colors: any;
};

const fmtZar = (n?: number | null) =>
  n == null ? "" : `R ${Number(n).toLocaleString("en-ZA")}`;

export function TransferToStockModal({
  visible,
  onClose,
  onSubmit,
  vehicleTitle,
  vehicleSubtitle,
  suggestedTargetZar,
  colors,
}: TransferToStockModalProps) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [stockNumber, setStockNumber] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset local state whenever the modal is toggled on/off — otherwise
  // a second transfer within the same session would pre-fill the last
  // dealer's values.
  React.useEffect(() => {
    if (visible) {
      setStockNumber("");
      setTargetPrice(suggestedTargetZar ? String(suggestedTargetZar) : "");
    }
  }, [visible, suggestedTargetZar]);

  const submit = useCallback(async () => {
    const sn = stockNumber.trim();
    if (!sn) {
      Alert.alert("Stock number required", "Please enter a unique stock number for this vehicle.");
      return;
    }
    const price = parseInt(targetPrice.replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(price) || price <= 0) {
      Alert.alert("Target price required", "Please enter your intended selling price in Rands.");
      return;
    }
    setSaving(true);
    try {
      await onSubmit({ stock_number: sn.toUpperCase(), target_sell_price_zar: price });
    } finally {
      setSaving(false);
    }
  }, [stockNumber, targetPrice, onSubmit]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Transfer to Stock</Text>
              <Text style={styles.vehicle} numberOfLines={2}>
                {vehicleTitle}
              </Text>
              {vehicleSubtitle ? (
                <Text style={styles.vehicleSub} numberOfLines={1}>
                  {vehicleSubtitle}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={onClose} activeOpacity={0.85} testID="transfer-modal-close">
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ gap: spacing.md, paddingTop: spacing.xs }}>
            {/* Stock number */}
            <View style={{ gap: 4 }}>
              <Text style={styles.label}>STOCK NUMBER *</Text>
              <TextInput
                testID="transfer-stock-number-input"
                value={stockNumber}
                onChangeText={setStockNumber}
                placeholder="e.g. STK-1234"
                placeholderTextColor={colors.textDisabled}
                autoCapitalize="characters"
                autoCorrect={false}
                style={styles.input}
              />
              <Text style={styles.helper}>
                Must be unique across your dealership. Stored in UPPERCASE.
              </Text>
            </View>

            {/* Target sell price */}
            <View style={{ gap: 4 }}>
              <Text style={styles.label}>TARGET SELLING PRICE (ZAR) *</Text>
              <View style={styles.priceWrap}>
                <Text style={styles.priceR}>R</Text>
                <TextInput
                  testID="transfer-target-price-input"
                  value={targetPrice}
                  onChangeText={setTargetPrice}
                  keyboardType="number-pad"
                  placeholder="0"
                  placeholderTextColor={colors.textDisabled}
                  style={styles.priceInput}
                />
              </View>
              {suggestedTargetZar ? (
                <Text style={styles.helper}>
                  Suggested (based on Fourbuy cover): {fmtZar(suggestedTargetZar)}
                </Text>
              ) : (
                <Text style={styles.helper}>
                  You can edit this later inside the Stock module.
                </Text>
              )}
            </View>

            <View style={styles.explain}>
              <Ionicons name="information-circle" size={14} color={colors.textSecondary} />
              <Text style={styles.explainTxt}>
                Only the vehicle basics (Year, Make, Derivative, M&M Code, Mileage,
                VIN, Colour, Condition Score, My Offer price) are copied into stock.
                Photos and marketing info stay on the original valuation.
              </Text>
            </View>
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity
              onPress={onClose}
              style={styles.cancelBtn}
              activeOpacity={0.85}
              disabled={saving}
              testID="transfer-modal-cancel"
            >
              <Text style={[styles.cancelBtnTxt, { color: colors.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={submit}
              disabled={saving}
              style={[styles.submitBtn, { backgroundColor: colors.primary }]}
              activeOpacity={0.85}
              testID="transfer-modal-submit"
            >
              {saving ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <>
                  <Ionicons name="arrow-forward-circle" size={16} color={colors.onPrimary} />
                  <Text style={[styles.submitBtnTxt, { color: colors.onPrimary }]}>Transfer</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.6)",
      alignItems: "center",
      justifyContent: "center",
      padding: spacing.md,
    },
    card: {
      width: "100%",
      maxWidth: 460,
      backgroundColor: colors.paper,
      borderRadius: radius.lg,
      padding: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      maxHeight: "90%",
    },
    header: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      marginBottom: spacing.sm,
    },
    title: {
      color: colors.text,
      fontSize: 18,
      fontWeight: "900",
      letterSpacing: -0.3,
    },
    vehicle: {
      color: colors.text,
      fontSize: 13,
      fontWeight: "700",
      marginTop: 4,
    },
    vehicleSub: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "600",
      marginTop: 1,
    },
    label: {
      color: colors.textSecondary,
      fontSize: 10,
      fontWeight: "800",
      letterSpacing: 0.7,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: colors.text,
      fontSize: 14,
      fontWeight: "700",
      backgroundColor: colors.bg,
      ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : {}),
    },
    priceWrap: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingHorizontal: 12,
      backgroundColor: colors.bg,
    },
    priceR: {
      color: colors.textSecondary,
      fontSize: 14,
      fontWeight: "700",
      marginRight: 6,
    },
    priceInput: {
      flex: 1,
      color: colors.text,
      fontSize: 14,
      fontWeight: "700",
      fontFamily: fonts.number,
      paddingVertical: 10,
      ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : {}),
    },
    helper: {
      color: colors.textDisabled,
      fontSize: 11,
      fontStyle: "italic",
    },
    explain: {
      flexDirection: "row",
      gap: 6,
      padding: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: "flex-start",
    },
    explainTxt: {
      flex: 1,
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "600",
      lineHeight: 15,
    },
    footer: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 8,
      marginTop: spacing.md,
    },
    cancelBtn: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cancelBtnTxt: {
      fontSize: 13,
      fontWeight: "800",
    },
    submitBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: radius.md,
      minWidth: 130,
    },
    submitBtnTxt: {
      color: colors.onPrimary,
      fontSize: 13,
      fontWeight: "800",
    },
  });
