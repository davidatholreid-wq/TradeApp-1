// -----------------------------------------------------------------------------
// DealTrackingCard — Stage 1 (Purchase) + Stage 2 (Sale) + Live P&L.
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P3 modularization pass (Aug 2026). This is the largest single block
// in the file — self-contained profit-analysis workflow for the owning
// dealer. Access rules (whether the card is rendered, whether it's
// editable, whether the reconditioning-sheet button is shown, etc.)
// remain in the parent; this component is presentational and reflects
// the pre-computed `canEdit`/`readOnly` state via props.
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text, ActivityIndicator, TextInput } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import type { DealInfo, DealProfit } from "@/src/types/vehicle";

export type OutcomeChoice = "pending" | "yes" | "no";

export type DealTrackingCardProps = {
  deal: DealInfo | null | undefined;
  profit: DealProfit | null | undefined;
  readOnly: boolean;
  // Stage 1
  dealDoneChoice: OutcomeChoice;
  onDoneChoice: (c: OutcomeChoice) => void;
  dealPurchaseInput: string;
  onPurchaseInputChange: (raw: string) => void;
  // Stage 2
  dealSoldChoice: OutcomeChoice;
  onSoldChoice: (c: OutcomeChoice) => void;
  dealReconInput: string;
  onReconInputChange: (raw: string) => void;
  dealSaleInput: string;
  onSaleInputChange: (raw: string) => void;
  // Save
  dealFinancialsDirty: boolean;
  dealSaving: boolean;
  onSave: () => void;
  // PDFs
  downloadingRecon: boolean;
  onDownloadReconPdf: () => void;
  // Supplier assignment (managerial only)
  canAssignSuppliers?: boolean;
  supplierAssignmentSummary?: {
    total: number;
    assigned: number;
  };
  onAssignSuppliers?: () => void;
  dealPdfDownloading: boolean;
  onDownloadProfitPdf: () => void;
  // Helpers
  formatMoneyString: (raw: string) => string;
  fmtZar: (v: number | null | undefined) => string;
  colors: any;
  styles: any;
};

export function DealTrackingCard({
  deal,
  profit,
  readOnly,
  dealDoneChoice,
  onDoneChoice,
  dealPurchaseInput,
  onPurchaseInputChange,
  dealSoldChoice,
  onSoldChoice,
  dealReconInput,
  onReconInputChange,
  dealSaleInput,
  onSaleInputChange,
  dealFinancialsDirty,
  dealSaving,
  onSave,
  downloadingRecon,
  onDownloadReconPdf,
  canAssignSuppliers,
  supplierAssignmentSummary,
  onAssignSuppliers,
  dealPdfDownloading,
  onDownloadProfitPdf,
  formatMoneyString,
  fmtZar,
  colors,
  styles,
}: DealTrackingCardProps) {
  const done = dealDoneChoice === "yes";
  const sold = dealSoldChoice === "yes";
  const canDownloadPdf = profit?.profit_zar != null;

  const outcome: "pending" | "deal_done" | "no_deal" =
    dealDoneChoice === "yes"
      ? "deal_done"
      : dealDoneChoice === "no"
        ? "no_deal"
        : "pending";
  const outcomeLabel =
    outcome === "deal_done"
      ? "DEAL DONE"
      : outcome === "no_deal"
        ? "NO DEAL DONE"
        : "PENDING OUTCOME";
  const outcomeStyle =
    outcome === "deal_done"
      ? styles.dealOutcomeOk
      : outcome === "no_deal"
        ? styles.dealOutcomeNo
        : styles.dealOutcomePending;
  const outcomeIcon: "checkmark-circle" | "close-circle" | "hourglass-outline" =
    outcome === "deal_done"
      ? "checkmark-circle"
      : outcome === "no_deal"
        ? "close-circle"
        : "hourglass-outline";

  return (
    <View style={styles.dealBox} testID="deal-tracking">
      <View style={styles.dealHeader}>
        <Ionicons name="briefcase-outline" size={18} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.dealTitle}>Deal Tracking &amp; Profit Analysis</Text>
          <Text style={styles.dealSub}>
            Private to your dealership and Fourbuy admin. Pricing agents
            never see this.
          </Text>
        </View>
        {readOnly ? (
          <View style={styles.dealBadge}>
            <Ionicons name="lock-closed" size={11} color={colors.textSecondary} />
            <Text style={styles.dealBadgeText}>ADMIN VIEW</Text>
          </View>
        ) : null}
      </View>

      {/* Outcome status pill */}
      <View style={[styles.dealOutcomePill, outcomeStyle]} testID="deal-outcome">
        <Ionicons name={outcomeIcon} size={14} color="#fff" />
        <Text style={styles.dealOutcomePillText}>{outcomeLabel}</Text>
      </View>

      {/* ------ Stage 1: Purchase ------ */}
      <View style={styles.dealStage} testID="deal-stage-1">
        <View style={styles.dealStageHeader}>
          <View style={styles.dealStagePill}>
            <Text style={styles.dealStagePillText}>1</Text>
          </View>
          <Text style={styles.dealStageTitle}>Did you do the deal?</Text>
        </View>
        <View style={styles.dealChoiceRow}>
          <TouchableOpacity
            testID="deal-done-pending"
            disabled={readOnly || dealSaving}
            style={[
              styles.dealChoiceBtn,
              dealDoneChoice === "pending" && styles.dealChoiceBtnPending,
            ]}
            onPress={() => onDoneChoice("pending")}
          >
            <Ionicons
              name="hourglass-outline"
              size={16}
              color={dealDoneChoice === "pending" ? "#fff" : colors.textSecondary}
            />
            <Text
              style={[
                styles.dealChoiceBtnText,
                dealDoneChoice === "pending" && styles.dealChoiceBtnTextActive,
              ]}
            >
              Pending
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="deal-done-yes"
            disabled={readOnly || dealSaving}
            style={[styles.dealChoiceBtn, done && styles.dealChoiceBtnYes]}
            onPress={() => onDoneChoice("yes")}
          >
            <Ionicons name="checkmark-circle" size={16}
              color={done ? "#fff" : colors.textSecondary} />
            <Text style={[styles.dealChoiceBtnText, done && styles.dealChoiceBtnTextActive]}>Yes</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="deal-done-no"
            disabled={readOnly || dealSaving}
            style={[styles.dealChoiceBtn, dealDoneChoice === "no" && styles.dealChoiceBtnNo]}
            onPress={() => onDoneChoice("no")}
          >
            <Ionicons name="close-circle" size={16}
              color={dealDoneChoice === "no" ? "#fff" : colors.textSecondary} />
            <Text style={[styles.dealChoiceBtnText, dealDoneChoice === "no" && styles.dealChoiceBtnTextActive]}>No</Text>
          </TouchableOpacity>
        </View>
        {done ? (
          <View style={styles.dealField}>
            <Text style={styles.dealFieldLabel}>Purchase price</Text>
            <View style={styles.dealInputWrap}>
              <Text style={styles.dealInputPrefix}>R</Text>
              <TextInput
                testID="deal-purchase-input"
                style={styles.dealInput}
                value={dealPurchaseInput}
                onChangeText={(t) => onPurchaseInputChange(formatMoneyString(t))}
                placeholder="0"
                placeholderTextColor={colors.textDisabled}
                keyboardType="numeric"
                editable={!readOnly && !dealSaving}
              />
            </View>
            {deal?.purchased_at ? (
              <Text style={styles.dealMeta}>
                Recorded {new Date(deal.purchased_at).toLocaleDateString()}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* Assign Suppliers pill — visible only for managerial users on the
          owning dealership once the deal is done. Sits above the
          Reconditioning Sheet download so it's a clear pre-flight step. */}
      {done && canAssignSuppliers && onAssignSuppliers ? (
        <TouchableOpacity
          testID="deal-assign-suppliers-pill"
          onPress={onAssignSuppliers}
          style={styles.assignSuppliersPill}
          accessibilityRole="button"
        >
          <Ionicons name="people-outline" size={14} color={colors.primary} />
          <Text style={styles.assignSuppliersPillText}>
            {supplierAssignmentSummary && supplierAssignmentSummary.total > 0
              ? `Allocate Suppliers to Recon · ${supplierAssignmentSummary.assigned}/${supplierAssignmentSummary.total}`
              : "Allocate Suppliers to Recon"}
          </Text>
        </TouchableOpacity>
      ) : null}

      {/* Reconditioning Requirement Sheet button (Stage 1 → Yes) */}
      {done ? (
        <TouchableOpacity
          testID="deal-download-recon-pdf"
          disabled={downloadingRecon}
          style={[styles.dealPdfBtn, styles.dealReconBtn]}
          onPress={onDownloadReconPdf}
        >
          {downloadingRecon ? (
            <ActivityIndicator size="small" color={colors.text} />
          ) : (
            <>
              <Ionicons name="construct-outline" size={16} color={colors.text} />
              <Text style={[styles.dealPdfBtnText, { color: colors.text }]}>
                Download Reconditioning Sheet
              </Text>
            </>
          )}
        </TouchableOpacity>
      ) : null}

      {/* ------ Stage 2: Sale (unlocked after Stage 1 = Yes) ------ */}
      {done ? (
        <View style={styles.dealStage} testID="deal-stage-2">
          <View style={styles.dealStageHeader}>
            <View style={styles.dealStagePill}>
              <Text style={styles.dealStagePillText}>2</Text>
            </View>
            <Text style={styles.dealStageTitle}>Have you sold the car?</Text>
          </View>
          <View style={styles.dealChoiceRow}>
            <TouchableOpacity
              testID="deal-sold-yes"
              disabled={readOnly || dealSaving}
              style={[styles.dealChoiceBtn, sold && styles.dealChoiceBtnYes]}
              onPress={() => onSoldChoice("yes")}
            >
              <Ionicons name="checkmark-circle" size={16}
                color={sold ? "#fff" : colors.textSecondary} />
              <Text style={[styles.dealChoiceBtnText, sold && styles.dealChoiceBtnTextActive]}>Yes</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="deal-sold-no"
              disabled={readOnly || dealSaving}
              style={[styles.dealChoiceBtn, dealSoldChoice === "no" && styles.dealChoiceBtnNo]}
              onPress={() => onSoldChoice("no")}
            >
              <Ionicons name="close-circle" size={16}
                color={dealSoldChoice === "no" ? "#fff" : colors.textSecondary} />
              <Text style={[styles.dealChoiceBtnText, dealSoldChoice === "no" && styles.dealChoiceBtnTextActive]}>Not yet</Text>
            </TouchableOpacity>
          </View>
          {sold ? (
            <>
              <View style={styles.dealField}>
                <Text style={styles.dealFieldLabel}>Reconditioning costs</Text>
                <View style={styles.dealInputWrap}>
                  <Text style={styles.dealInputPrefix}>R</Text>
                  <TextInput
                    testID="deal-recon-input"
                    style={styles.dealInput}
                    value={dealReconInput}
                    onChangeText={(t) => onReconInputChange(formatMoneyString(t))}
                    placeholder="0"
                    placeholderTextColor={colors.textDisabled}
                    keyboardType="numeric"
                    editable={!readOnly && !dealSaving}
                  />
                </View>
              </View>
              <View style={styles.dealField}>
                <Text style={styles.dealFieldLabel}>Sale price</Text>
                <View style={styles.dealInputWrap}>
                  <Text style={styles.dealInputPrefix}>R</Text>
                  <TextInput
                    testID="deal-sale-input"
                    style={styles.dealInput}
                    value={dealSaleInput}
                    onChangeText={(t) => onSaleInputChange(formatMoneyString(t))}
                    placeholder="0"
                    placeholderTextColor={colors.textDisabled}
                    keyboardType="numeric"
                    editable={!readOnly && !dealSaving}
                  />
                </View>
                {deal?.sold_at ? (
                  <Text style={styles.dealMeta}>
                    Sold on {new Date(deal.sold_at).toLocaleDateString()}
                  </Text>
                ) : null}
              </View>
            </>
          ) : null}
        </View>
      ) : null}

      {/* Explicit Save button (dealer-editable path) */}
      {!readOnly ? (
        <TouchableOpacity
          testID="deal-save-button"
          style={[
            styles.dealSaveBtn,
            dealFinancialsDirty ? styles.dealSaveBtnPrimary : styles.dealSaveBtnSaved,
          ]}
          disabled={!dealFinancialsDirty || dealSaving}
          onPress={onSave}
          accessibilityLabel="Save deal tracking details"
        >
          {dealSaving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : dealFinancialsDirty ? (
            <>
              <Ionicons name="save-outline" size={16} color="#fff" />
              <Text style={styles.dealSaveBtnText}>Save Deal Tracking</Text>
            </>
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={16} color={colors.textSecondary} />
              <Text style={[styles.dealSaveBtnText, { color: colors.textSecondary }]}>Saved</Text>
            </>
          )}
        </TouchableOpacity>
      ) : null}

      {/* Live P&L callout + PDF */}
      {profit && profit.cost_basis_zar != null ? (
        <View
          style={[
            styles.dealPnl,
            profit.profit_zar != null && profit.profit_zar >= 0
              ? styles.dealPnlOk
              : profit.profit_zar != null
                ? styles.dealPnlLoss
                : styles.dealPnlNeutral,
          ]}
          testID="deal-pnl"
        >
          <View style={styles.dealPnlRow}>
            <Text style={styles.dealPnlLbl}>Purchase</Text>
            <Text style={styles.dealPnlVal}>{fmtZar(profit.purchase_price_zar)}</Text>
          </View>
          <View style={styles.dealPnlRow}>
            <Text style={styles.dealPnlLbl}>Recon</Text>
            <Text style={styles.dealPnlVal}>{fmtZar(profit.recon_cost_zar)}</Text>
          </View>
          <View style={[styles.dealPnlRow, styles.dealPnlDivider]}>
            <Text style={styles.dealPnlLbl}>Cost basis</Text>
            <Text style={styles.dealPnlVal}>{fmtZar(profit.cost_basis_zar)}</Text>
          </View>
          <View style={styles.dealPnlRow}>
            <Text style={styles.dealPnlLbl}>Sale</Text>
            <Text style={styles.dealPnlVal}>{fmtZar(profit.sale_price_zar)}</Text>
          </View>
          <View style={[styles.dealPnlRow, styles.dealPnlProfitRow]}>
            <Text style={styles.dealPnlProfitLbl}>
              {profit.profit_zar != null && profit.profit_zar < 0 ? "Loss" : "Gross profit"}
            </Text>
            <View style={{ alignItems: "flex-end" }}>
              <Text
                style={[
                  styles.dealPnlProfitVal,
                  profit.profit_zar != null && profit.profit_zar < 0 && styles.dealPnlProfitValLoss,
                ]}
              >
                {fmtZar(profit.profit_zar)}
              </Text>
              {profit.margin_pct != null ? (
                <Text style={styles.dealPnlMargin}>{profit.margin_pct}% margin</Text>
              ) : null}
            </View>
          </View>
          {canDownloadPdf ? (
            <TouchableOpacity
              testID="deal-download-pdf"
              disabled={dealPdfDownloading}
              style={styles.dealPdfBtn}
              onPress={onDownloadProfitPdf}
            >
              {dealPdfDownloading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="download-outline" size={16} color="#fff" />
                  <Text style={styles.dealPdfBtnText}>Download Profit Analysis PDF</Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export default DealTrackingCard;
