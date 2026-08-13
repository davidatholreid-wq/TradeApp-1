// -----------------------------------------------------------------------------
// TransferToStockCard — replaces the old Deal Tracking flow.
//
// After Aug 2026 the "stock list" is its own MongoDB collection
// (`stock_items`), decoupled from the submission's `deal` object. On
// the vehicle-detail screen this card is the ONLY entry-point between
// a valuation and the dealer's stock list:
//
//   • Not transferred → shows a "Transfer to Stock" CTA that opens the
//     TransferToStockModal (stock_number + target_sell_price form).
//   • Transferred     → shows the STK-#### badge, Un-transfer button,
//     Assign Suppliers pill, and the Download Reconditioning Sheet
//     button.  The Recon PDF is intentionally still exposed here per
//     product spec — it's the one artefact from the old Deal Tracking
//     flow that survived the rework.
//
// The card is entirely presentational — access rules, transfer/un-
// transfer network calls, and PDF downloads all live in the parent
// (`app/(app)/vehicle/[id].tsx`).  This component just reflects the
// pre-computed state via props.
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";

export type TransferToStockCardProps = {
  // Server-side transferred state ---------------------------------------
  stockItemId?: string | null;
  stockNumber?: string | null;
  transferredAt?: string | null;
  // Guard: is the submission a full valuation (priced)? Subject-to-view
  // submissions cannot be transferred until they're fully priced.
  isFullyValued: boolean;
  // Access ---------------------------------------------------------------
  // The card is visible to any user on the owning dealership + admin,
  // but only managerial users can transfer / un-transfer.  Non-manager
  // dealers see a read-only view.
  canTransfer: boolean;
  // Actions --------------------------------------------------------------
  onOpenTransferModal: () => void;
  onUntransfer: () => void;
  untransferring: boolean;
  // Recon PDF (available once transferred).
  downloadingRecon: boolean;
  onDownloadReconPdf: () => void;
  // Supplier assignment (managerial only, available once transferred).
  supplierAssignmentSummary?: {
    total: number;
    assigned: number;
  };
  onAssignSuppliers?: () => void;
  // Theme ----------------------------------------------------------------
  colors: any;
};

export function TransferToStockCard({
  stockItemId,
  stockNumber,
  transferredAt,
  isFullyValued,
  canTransfer,
  onOpenTransferModal,
  onUntransfer,
  untransferring,
  downloadingRecon,
  onDownloadReconPdf,
  supplierAssignmentSummary,
  onAssignSuppliers,
  colors,
}: TransferToStockCardProps) {
  const styles = makeStyles(colors);
  const isInStock = !!stockItemId;

  return (
    <View style={styles.box} testID="transfer-to-stock-card">
      <View style={styles.header}>
        <Ionicons name="car-sport-outline" size={18} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Stock</Text>
          <Text style={styles.subtitle}>
            {isInStock
              ? "This vehicle is in your dealership stock list."
              : "Transfer this valuation into your stock list once the deal is done."}
          </Text>
        </View>
        {isInStock ? (
          <View style={styles.badge}>
            <Ionicons name="checkmark-circle" size={12} color="#fff" />
            <Text style={styles.badgeTxt} numberOfLines={1}>
              {stockNumber || "IN STOCK"}
            </Text>
          </View>
        ) : null}
      </View>

      {!isInStock ? (
        // ============ NOT TRANSFERRED ============
        <>
          {!isFullyValued ? (
            <View style={styles.notice} testID="transfer-guard-notice">
              <Ionicons name="alert-circle" size={14} color="#F97316" />
              <Text style={styles.noticeTxt}>
                Subject-to-view vehicles can't be transferred to stock yet — please
                complete the full valuation first.
              </Text>
            </View>
          ) : null}
          <TouchableOpacity
            testID="transfer-to-stock-open-btn"
            disabled={!canTransfer || !isFullyValued}
            onPress={onOpenTransferModal}
            style={[
              styles.primaryBtn,
              (!canTransfer || !isFullyValued) && styles.primaryBtnDisabled,
              { backgroundColor: colors.primary },
            ]}
            activeOpacity={0.85}
          >
            <Ionicons name="arrow-forward-circle" size={18} color={colors.onPrimary} />
            <Text style={[styles.primaryBtnTxt, { color: colors.onPrimary }]}>Transfer to Stock</Text>
          </TouchableOpacity>
          {!canTransfer && isFullyValued ? (
            <Text style={styles.hintTxt}>
              Only managerial users on this dealership can transfer vehicles into stock.
            </Text>
          ) : null}
        </>
      ) : (
        // ============ IN STOCK ============
        <>
          {transferredAt ? (
            <Text style={styles.transferMeta}>
              Transferred {new Date(transferredAt).toLocaleString()}
            </Text>
          ) : null}

          {/* Assign Suppliers pill (managerial only). Kept above the
              recon PDF so it reads as a pre-flight step. */}
          {onAssignSuppliers && canTransfer ? (
            <TouchableOpacity
              testID="stock-assign-suppliers-pill"
              onPress={onAssignSuppliers}
              style={styles.pill}
              activeOpacity={0.85}
            >
              <Ionicons name="people-outline" size={14} color={colors.primary} />
              <Text style={styles.pillTxt}>
                {supplierAssignmentSummary && supplierAssignmentSummary.total > 0
                  ? `Allocate Suppliers to Recon · ${supplierAssignmentSummary.assigned}/${supplierAssignmentSummary.total}`
                  : "Allocate Suppliers to Recon"}
              </Text>
            </TouchableOpacity>
          ) : null}

          {/* Reconditioning Requirement Sheet — the one legacy PDF that
              survived the Deal Tracking rework. */}
          <TouchableOpacity
            testID="stock-download-recon-pdf"
            disabled={downloadingRecon}
            style={styles.secondaryBtn}
            onPress={onDownloadReconPdf}
            activeOpacity={0.85}
          >
            {downloadingRecon ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <>
                <Ionicons name="construct-outline" size={16} color={colors.text} />
                <Text style={[styles.secondaryBtnTxt, { color: colors.text }]}>
                  Download Reconditioning Sheet
                </Text>
              </>
            )}
          </TouchableOpacity>

          {/* Un-transfer — moved to the bottom so it doesn't get
              tapped accidentally.  Sold items are blocked server-side. */}
          {canTransfer ? (
            <TouchableOpacity
              testID="untransfer-stock-btn"
              disabled={untransferring}
              onPress={onUntransfer}
              style={styles.destructiveBtn}
              activeOpacity={0.85}
            >
              {untransferring ? (
                <ActivityIndicator size="small" color="#DC2626" />
              ) : (
                <>
                  <Ionicons name="arrow-undo" size={14} color="#DC2626" />
                  <Text style={styles.destructiveBtnTxt}>Remove from Stock</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </>
      )}
    </View>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    box: {
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.paper,
      padding: spacing.md,
      marginBottom: spacing.md,
      gap: spacing.sm,
    },
    header: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
    },
    title: {
      color: colors.text,
      fontSize: 15,
      fontWeight: "900",
      letterSpacing: -0.2,
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: "600",
      marginTop: 1,
    },
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 999,
      backgroundColor: "#16A34A",
    },
    badgeTxt: {
      color: "#fff",
      fontSize: 11,
      fontWeight: "900",
      letterSpacing: 0.4,
      maxWidth: 120,
    },
    notice: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      padding: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: "#F97316" + "18",
      borderWidth: 1,
      borderColor: "#F97316" + "55",
    },
    noticeTxt: {
      flex: 1,
      color: colors.text,
      fontSize: 12,
      fontWeight: "600",
    },
    primaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 12,
      borderRadius: radius.md,
    },
    primaryBtnDisabled: {
      opacity: 0.4,
    },
    primaryBtnTxt: {
      color: colors.onPrimary,
      fontSize: 14,
      fontWeight: "800",
      letterSpacing: 0.2,
    },
    hintTxt: {
      color: colors.textDisabled,
      fontSize: 11,
      fontStyle: "italic",
      textAlign: "center",
    },
    transferMeta: {
      color: colors.textSecondary,
      fontSize: 11,
      fontWeight: "600",
      fontStyle: "italic",
    },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.primary + "66",
      backgroundColor: colors.primary + "18",
    },
    pillTxt: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: "800",
      letterSpacing: 0.2,
    },
    secondaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 10,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
    },
    secondaryBtnTxt: {
      fontSize: 13,
      fontWeight: "800",
      letterSpacing: 0.2,
      fontFamily: fonts.number,
    },
    destructiveBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 8,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: "#DC2626" + "66",
      backgroundColor: "#DC2626" + "10",
    },
    destructiveBtnTxt: {
      color: "#DC2626",
      fontSize: 12,
      fontWeight: "800",
    },
  });
