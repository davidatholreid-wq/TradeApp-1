// -----------------------------------------------------------------------------
// Report modals — extracted from `/app/frontend/app/(app)/vehicle/[id].tsx`
// during the P1 pass-2 modularization (Aug 2026). Two modals live here
// because they're the report-order pair (confirm charge → view result):
//
//   • ConfirmReportModal — asked before a paid report is ordered
//     (Lightstone / CarVertical / BMW Options / JLR OSH / Kredo VIN).
//   • ViewReportModal    — renders the delivered report's structured
//     result payload, plus an "Open Full Report PDF" CTA.
//
// Both modals were previously inlined at the tail of the render tree
// of `VehicleDetail`. They're presentational (only Ionicons + local
// touches) — every piece of state (`confirmReport`, `viewingReport`,
// `orderingReportType`, the submit / open handlers) stays in the
// parent component and is threaded down through the props. This
// keeps the extraction reversible and the parent's `useEffect` /
// state machine intact.
// -----------------------------------------------------------------------------
import React from "react";
import { View, Text, Modal, Pressable, StyleSheet, ScrollView, ActivityIndicator } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing } from "@/src/theme";
import ReportResultBody from "@/src/components/vehicle/ReportResultBody";
import type { ReportOrder } from "@/src/types/vehicle";

// ---------------------------------------------------------------------------
// ConfirmReportModal
// ---------------------------------------------------------------------------

export type ConfirmReportModalProps = {
  visible: boolean;
  report: ReportOrder | null;
  vin?: string | null;
  ordering: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  colors: any;
  styles: any;
};

export function ConfirmReportModal({
  visible, report, vin, ordering, onCancel, onConfirm, colors, styles,
}: ConfirmReportModalProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => (ordering ? null : onCancel())}
    >
      <View style={styles.reportModalBackdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => (ordering ? null : onCancel())}
        />
        <View style={styles.reportModalCard}>
          <View style={styles.reportModalHeader}>
            <Ionicons name="receipt-outline" size={22} color={colors.text} />
            <Text style={styles.reportModalTitle}>Confirm Charge</Text>
          </View>
          <Text style={styles.reportModalReport}>{report?.name}</Text>
          <Text style={styles.reportModalPrice}>
            R{report?.cost_zar?.toFixed(0) ?? "0"}
          </Text>
          <Text style={styles.reportModalBody}>
            By continuing, you accept the charge of R{report?.cost_zar?.toFixed(0) ?? "0"}.
            This amount will be added to your next TradeAPP invoice alongside the R50 valuation fee.
          </Text>
          <Text style={styles.reportModalBodySmall}>
            The report will be run against VIN {vin || "—"}.
          </Text>

          <View style={styles.reportModalActions}>
            <TouchableOpacity
              testID="cancel-report-order"
              style={styles.reportModalCancel}
              onPress={onCancel}
              disabled={ordering}
            >
              <Text style={styles.reportModalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="confirm-report-order"
              style={[
                styles.reportModalConfirm,
                ordering && styles.docBtnDisabled,
              ]}
              onPress={onConfirm}
              disabled={ordering}
            >
              {ordering ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.reportModalConfirmText}>
                  Accept & Order
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// ViewReportModal
// ---------------------------------------------------------------------------

export type ViewReportModalProps = {
  report: ReportOrder | null;
  onClose: () => void;
  onOpenPdf: (type: ReportOrder["type"]) => void;
  colors: any;
  styles: any;
};

export function ViewReportModal({
  report, onClose, onOpenPdf, colors, styles,
}: ViewReportModalProps) {
  const isLegacyMock =
    !!report && (
      report.type === "lightstone_verification"
      || report.type === "lightstone_repair"
      || report.type === "car_vertical"
    );

  return (
    <Modal
      visible={report !== null}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.reportModalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.viewReportCard}>
          <View style={styles.viewReportHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.viewReportKicker}>
                {report?.status?.toUpperCase() || "REPORT"}
              </Text>
              <Text style={styles.viewReportTitle}>{report?.name}</Text>
              <Text style={styles.viewReportMeta}>
                VIN {report?.vin} · Delivered {(report?.delivered_at || report?.ordered_at || "").slice(0, 10)}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} testID="close-report-viewer">
              <Ionicons name="close" size={26} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ maxHeight: 480 }} contentContainerStyle={{ paddingBottom: spacing.md }}>
            {report?.result_data ? (
              <ReportResultBody data={report.result_data} />
            ) : (
              <Text style={styles.viewReportBody}>
                This report was ordered but no result payload is attached yet.
              </Text>
            )}
            {/* Legacy Lightstone / Car Vertical integrations are still
                fixture-backed; show the MOCK DATA note only for those.
                JLR OSH, BMW Options, Kredo VIN accident history and
                Kredo CarTrust are all live provider integrations. */}
            {isLegacyMock ? (
              <View style={styles.mockBanner}>
                <Ionicons name="information-circle-outline" size={16} color={colors.textDisabled} />
                <Text style={styles.mockBannerText}>
                  MOCK DATA — real provider APIs will replace this content once integrated.
                </Text>
              </View>
            ) : null}
          </ScrollView>

          {report?.status === "delivered" ? (
            <TouchableOpacity
              testID="open-report-pdf"
              style={styles.reportPdfBtn}
              onPress={() => report && onOpenPdf(report.type)}
            >
              <Ionicons name="document-text-outline" size={18} color={colors.onPrimary} />
              <Text style={styles.reportPdfBtnText}>Open Full Report PDF</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
