// -----------------------------------------------------------------------------
// VinLinkedReportsCard — "Order a VIN-Linked Report" collapsible section.
//
// Extracted from `/app/frontend/app/(app)/vehicle/[id].tsx` during the
// P3 modularization pass (Aug 2026). Renders the unified list of VIN
// reports the dealer can order (Lightstone Verification/Repair, Car
// Vertical, BMW factory options, Land Rover OSH, Kredo accident/claim
// history) plus the async Kredo CarTrust card. Admins and pricing
// agents see the same layout in read-only mode (view already-purchased
// reports only).
//
// The parent still owns:
//   • the REPORT_CATALOG map (name/cost per report type)
//   • cartrust state (status/error/loading)
//   • the confirm-order modal state (via setConfirmReport)
//   • the view-report modal state (via setViewingReport)
//   • the router push into the license-disk scan flow
// This component is purely presentational and forwards the callbacks.
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing } from "@/src/theme";
import CollapsibleSection from "@/src/components/vehicle/CollapsibleSection";
import type { Submission, ReportOrder } from "@/src/types/vehicle";

export type CartrustState = {
  status: "pending" | "completed" | "failed" | string;
  error?: string | null;
  ownership_status?: "populated" | "pending" | "unknown" | null;
  last_callback_at?: string | null;
} | null | undefined;

export type ConfirmReportChoice = {
  type: ReportOrder["type"] | "kredo_cartrust";
  name: string;
  cost_zar: number;
};

export type ReportCatalog = Record<
  ReportOrder["type"] | "kredo_cartrust",
  { name: string; cost_zar: number }
>;

export type VinLinkedReportsCardProps = {
  sub: Submission;
  isAdmin: boolean;
  isCoverMode: boolean;
  isBimmerSupported: boolean;
  isMbSupported: boolean;
  isOutvinSupported: boolean;
  /** Dynamic label rewritten per-submission: "<Make> Factory Options"
      (e.g. "Volkswagen Factory Options"). Falls back to the generic
      catalog name if not supplied. */
  outvinReportLabel?: string;
  isLandroverSupported: boolean;
  isPorscheSupported: boolean;
  isFerrariSupported: boolean;
  reportCatalog: ReportCatalog;
  orderedReportTypes: Set<string>;
  orderingReportType: string | null;
  cartrust: CartrustState;
  cartrustLoading: boolean;
  open: boolean;
  onToggle: () => void;
  onViewReport: (order: ReportOrder) => void;
  onConfirmOrder: (choice: ConfirmReportChoice) => void;
  onOpenCartrust: () => void;
  onScanLicenseDisk: () => void;
  colors: any;
  styles: any;
};

export function VinLinkedReportsCard({
  sub,
  isAdmin,
  isCoverMode,
  isBimmerSupported,
  isMbSupported,
  isOutvinSupported,
  outvinReportLabel,
  isLandroverSupported,
  isPorscheSupported,
  isFerrariSupported,
  reportCatalog,
  orderedReportTypes,
  orderingReportType,
  cartrust,
  cartrustLoading,
  open,
  onToggle,
  onViewReport,
  onConfirmOrder,
  onOpenCartrust,
  onScanLicenseDisk,
  colors,
  styles,
}: VinLinkedReportsCardProps) {
  const nonCoverOrders = (sub.report_orders || []).filter(
    (r) => r.type !== ("cover_offer" as any),
  );

  return (
    <CollapsibleSection
      title={isAdmin || isCoverMode ? "VIN-Linked Reports" : "Order a VIN-Linked Report"}
      open={open}
      onToggle={onToggle}
      summary={
        nonCoverOrders.length > 0
          ? `${nonCoverOrders.length} report${nonCoverOrders.length === 1 ? "" : "s"} ordered`
          : (isAdmin || isCoverMode) ? "No reports ordered yet" : "Tap to view available reports"
      }
      colors={colors}
      styles={styles}
      testID="reports-section"
    >
      {sub.vin && sub.vin.trim() && sub.vin.toUpperCase() !== "TBC" ? (
        <>
          {isAdmin || isCoverMode ? (
            (sub.report_orders || []).length > 0 ? (
              <>
                <Text style={styles.reportsSubhead}>
                  {isCoverMode ? "VIN reports ordered by the seller" : "VIN reports ordered by dealer"}
                </Text>
                <Text style={styles.reportsHelp}>
                  Verified against VIN {sub.vin}.
                  {isCoverMode
                    ? " Pricing agents can view results but cannot order new reports."
                    : " Admins can view results but cannot order reports on behalf of a dealer."}
                </Text>
              </>
            ) : (
              <View style={styles.adminNoReports}>
                <Ionicons name="lock-closed-outline" size={16} color={colors.textDisabled} />
                <Text style={styles.adminNoReportsText}>
                  {isCoverMode
                    ? "The seller has not purchased any VIN-linked reports yet."
                    : "VIN reports can only be ordered by the dealer. None purchased yet."}
                </Text>
              </View>
            )
          ) : (
            <>
              <Text style={styles.reportsSubhead}>Order a VIN-linked report</Text>
              <Text style={styles.reportsHelp}>
                Reports are verified against VIN {sub.vin}. The charge will be added to your next invoice.
              </Text>
            </>
          )}

          {((): ReportOrder["type"][] => {
            // Aug 2026: Lightstone Verification / Repair and CarVertical
            // removed from the catalog — those integrations were never
            // wired to a real API. Historical orders keep rendering
            // via ReportModals.tsx so no data is lost.
            const baseTypes: ReportOrder["type"][] = [];
            if (isBimmerSupported) baseTypes.push("bmw_options");
            if (isMbSupported) baseTypes.push("mb_options");
            if (isOutvinSupported) baseTypes.push("outvin_spec");
            if (isLandroverSupported) baseTypes.push("landrover_osh");
            if (isPorscheSupported) baseTypes.push("porsche_vin");
            if (isFerrariSupported) baseTypes.push("ferrari_vin");
            if (sub.vin && sub.vin.trim() && sub.vin.toUpperCase() !== "TBC") {
              baseTypes.push("kredo_vin_history");
            }
            return baseTypes;
          })()
            .filter((t) => (!isAdmin && !isCoverMode) || orderedReportTypes.has(t))
            .map((t) => {
              const meta = reportCatalog[t];
              // Rewrite the row name for the Outvin multi-make report so
              // dealers see "Volkswagen Factory Options" instead of the
              // generic catalog label. Fallback to the catalog name for
              // any other report or when the make couldn't be resolved.
              const displayName =
                t === "outvin_spec" && outvinReportLabel
                  ? outvinReportLabel
                  : meta.name;
              const alreadyOrdered = orderedReportTypes.has(t);
              const existing = (sub.report_orders || []).find((r) => r.type === t);
              const busy = orderingReportType === t;
              const isDelivered = existing?.status === "delivered";
              return (
                <View key={t} style={styles.reportCard}>
                  <View style={{ flex: 1, marginRight: spacing.sm }}>
                    <Text style={styles.reportName}>{displayName}</Text>
                    <Text style={styles.reportCost}>R{meta.cost_zar.toFixed(0)}</Text>
                    {alreadyOrdered ? (
                      <View style={styles.reportStatusRow}>
                        <View
                          style={[
                            styles.statusPill,
                            isDelivered ? styles.statusPillOk : styles.statusPillPending,
                          ]}
                        >
                          <Text
                            style={[
                              styles.statusPillText,
                              isDelivered
                                ? { color: colors.success }
                                : { color: colors.warning },
                            ]}
                          >
                            {(existing?.status || "pending").toUpperCase()}
                          </Text>
                        </View>
                        {!isDelivered ? (
                          <Text style={styles.reportPendingNote} numberOfLines={2}>
                            {existing?.note ||
                              "Awaiting API integration — result will appear here once the provider responds."}
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                  {alreadyOrdered ? (
                    isDelivered ? (
                      <TouchableOpacity
                        testID={`view-report-${t}`}
                        style={styles.viewReportBtn}
                        onPress={() => existing && onViewReport(existing)}
                      >
                        <Ionicons name="eye-outline" size={16} color={colors.onPrimary} />
                        <Text style={styles.viewReportBtnText}>View</Text>
                      </TouchableOpacity>
                    ) : (
                      <View style={styles.reportOrderedBadge}>
                        <Ionicons name="checkmark" size={16} color={colors.text} />
                        <Text style={styles.reportOrderedBadgeText}>Ordered</Text>
                      </View>
                    )
                  ) : (
                    <TouchableOpacity
                      testID={`order-report-${t}`}
                      style={[styles.orderBtn, busy && styles.docBtnDisabled]}
                      onPress={() =>
                        onConfirmOrder({ type: t, name: displayName, cost_zar: meta.cost_zar })
                      }
                      disabled={busy}
                    >
                      {busy ? (
                        <ActivityIndicator color={colors.onPrimary} size="small" />
                      ) : (
                        <Text style={styles.orderBtnText}>Order</Text>
                      )}
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}

          {/* Kredo CarTrust — dealer sees it always; admin/cover only after order */}
          {((!isAdmin && !isCoverMode) || cartrust) ? (
            <View style={styles.reportCard} testID="cartrust-card">
              <View style={{ flex: 1, marginRight: spacing.sm }}>
                <Text style={styles.reportName}>{reportCatalog.kredo_cartrust.name}</Text>
                <Text style={styles.reportCost}>R{reportCatalog.kredo_cartrust.cost_zar.toFixed(0)}</Text>
                {cartrust ? (
                  <View style={styles.reportStatusRow}>
                    <View
                      style={[
                        styles.statusPill,
                        cartrust.status === "completed"
                          ? styles.statusPillOk
                          : styles.statusPillPending,
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusPillText,
                          cartrust.status === "completed"
                            ? styles.statusPillTextOk
                            : styles.statusPillTextPending,
                        ]}
                      >
                        {String(cartrust.status).toUpperCase()}
                      </Text>
                    </View>
                    {/* Inline "Natis Owners Query Pending" pill — surfaced when
                        Kredo's ownership feed hasn't backfilled yet. Kept as a
                        single compact chip so it slots next to the status pill
                        without breaking the row into a 4-line block on narrow
                        phone widths. */}
                    {cartrust.status === "completed" &&
                    cartrust.ownership_status === "pending" ? (
                      <View
                        style={styles.cartrustOwnershipChip}
                        testID="cartrust-ownership-pending"
                      >
                        <Ionicons
                          name="time-outline"
                          size={11}
                          color={(colors as any).warningText || "#78350F"}
                        />
                        <Text style={styles.cartrustOwnershipChipText}>
                          Natis Owners Query Pending
                        </Text>
                      </View>
                    ) : (
                      <Text style={styles.reportStatusMeta}>
                        {cartrust.status === "pending"
                          ? "Kredo is preparing your report…"
                          : cartrust.status === "completed"
                            ? "Ready to view"
                            : (cartrust.error || "Please try again")}
                      </Text>
                    )}
                  </View>
                ) : null}
              </View>
              {cartrust?.status === "completed" ? (
                <TouchableOpacity
                  testID="cartrust-view-btn"
                  style={styles.viewReportBtn}
                  onPress={onOpenCartrust}
                >
                  <Ionicons name="eye-outline" size={16} color={colors.onPrimary} />
                  <Text style={styles.viewReportBtnText}>View</Text>
                </TouchableOpacity>
              ) : cartrust?.status === "pending" ? (
                <View style={styles.reportOrderedBadge}>
                  <ActivityIndicator color={colors.text} size="small" />
                  <Text style={styles.reportOrderedBadgeText}>Ordered</Text>
                </View>
              ) : !isAdmin && !isCoverMode ? (
                <TouchableOpacity
                  testID="cartrust-order-btn"
                  style={[styles.orderBtn, cartrustLoading && styles.docBtnDisabled]}
                  onPress={() =>
                    onConfirmOrder({
                      type: "kredo_cartrust",
                      name: reportCatalog.kredo_cartrust.name,
                      cost_zar: reportCatalog.kredo_cartrust.cost_zar,
                    })
                  }
                  disabled={cartrustLoading}
                >
                  {cartrustLoading ? (
                    <ActivityIndicator color={colors.onPrimary} size="small" />
                  ) : (
                    <Text style={styles.orderBtnText}>Order</Text>
                  )}
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
        </>
      ) : (
        // No VIN → surface the scan-license-disk explainer.
        <View style={styles.vinRequiredBox} testID="vin-required-notice">
          <Ionicons name="scan-outline" size={20} color={colors.textSecondary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.vinRequiredTitle}>License disk required</Text>
            <Text style={styles.vinRequiredHint}>
              The VIN-Linked report requires you to capture the license
              disk. Scan it to unlock Lightstone, Kredo accident history,
              CarTrust and factory-option reports. Won&apos;t create a
              new billable valuation.
            </Text>
            {!isAdmin && !isCoverMode ? (
              <TouchableOpacity
                testID="scan-license-disk-cta"
                style={styles.vinRequiredBtn}
                onPress={onScanLicenseDisk}
                accessibilityRole="button"
              >
                <Ionicons name="scan" size={14} color={colors.onPrimary} />
                <Text style={styles.vinRequiredBtnText}>Capture license disk</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      )}
    </CollapsibleSection>
  );
}

export default VinLinkedReportsCard;
