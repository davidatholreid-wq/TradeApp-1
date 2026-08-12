// -----------------------------------------------------------------------------
// PriceModal + DeclineModal — extracted from
// `/app/frontend/app/(app)/vehicle/[id].tsx` during the P1 pass-2
// modularization (Aug 2026). Both belong to the admin's "action bar"
// on a pending / priced submission. They stay fully controlled by
// the parent so all validation, submit handlers and side-effects
// (price history logging, WhatsApp notifications, cover-mode
// broadcasts) continue to live where they used to.
// -----------------------------------------------------------------------------
import React from "react";
import {
  View, Text, Modal, Pressable, StyleSheet, KeyboardAvoidingView,
  Platform, TextInput, ActivityIndicator,
} from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing } from "@/src/theme";
import type { Submission } from "@/src/types/vehicle";

// ---------------------------------------------------------------------------
// PriceModal
// ---------------------------------------------------------------------------

export type PriceModalProps = {
  visible: boolean;
  sub: Submission;
  priceInput: string;
  notesInput: string;
  changeCommentInput: string;
  submitting: boolean;
  onPriceInputChange: (t: string) => void;
  onNotesInputChange: (t: string) => void;
  onChangeCommentInputChange: (t: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  formatZAR: (n: number) => string;
  formatMoneyString: (s: string) => string;
  colors: any;
  styles: any;
};

export function PriceModal({
  visible, sub,
  priceInput, notesInput, changeCommentInput, submitting,
  onPriceInputChange, onNotesInputChange, onChangeCommentInputChange,
  onClose, onSubmit,
  formatZAR, formatMoneyString,
  colors, styles,
}: PriceModalProps) {
  const isUpdate = sub.status === "priced";
  const cannotSubmit = submitting || (isUpdate && changeCommentInput.trim().length < 3);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              {isUpdate ? "Update Price" : "Offer Price"}
            </Text>
            <TouchableOpacity testID="price-modal-close" onPress={onClose}>
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
          <Text style={styles.modalHint}>
            {sub.year} {sub.make_name} {sub.derivative_name || sub.model_name}
          </Text>
          {isUpdate && sub.price != null ? (
            <Text style={[styles.modalHint, { marginTop: 2 }]}>
              Previous offer: <Text style={{ color: colors.text, fontWeight: "700" }}>{formatZAR(sub.price)}</Text>
            </Text>
          ) : null}
          <Text style={styles.label}>Price (ZAR)</Text>
          <TextInput
            testID="price-input"
            style={styles.priceInput}
            value={priceInput}
            onChangeText={(t) => onPriceInputChange(formatMoneyString(t))}
            placeholder="0"
            placeholderTextColor={colors.textDisabled}
            keyboardType="numeric"
            autoFocus
          />
          <Text style={styles.label}>Notes (optional, shown to dealer)</Text>
          <TextInput
            testID="notes-input"
            style={[styles.priceInput, { height: 60 }]}
            value={notesInput}
            onChangeText={onNotesInputChange}
            placeholder="e.g. Trade price offer valid 7 days"
            placeholderTextColor={colors.textDisabled}
            multiline
          />
          <Text style={styles.label}>
            {isUpdate ? (
              <>
                Reason for the price change{" "}
                <Text style={{ color: "#B3261E", fontWeight: "800" }}>*</Text>
              </>
            ) : (
              <>Change comment (optional — reason for this offer)</>
            )}
          </Text>
          <TextInput
            testID="change-comment-input"
            style={[styles.priceInput, { height: 60 }]}
            value={changeCommentInput}
            onChangeText={onChangeCommentInputChange}
            placeholder={
              isUpdate
                ? "e.g. Adjusted for higher mileage; matched new market comps"
                : "e.g. Initial offer based on average trade condition"
            }
            placeholderTextColor={colors.textDisabled}
            multiline
          />
          {isUpdate ? (
            <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 4, fontStyle: "italic" }}>
              A reason is required and will be logged in the price history.
            </Text>
          ) : null}
          <TouchableOpacity
            testID="confirm-price-button"
            style={[styles.confirmBtn, cannotSubmit && { opacity: 0.5 }]}
            onPress={onSubmit}
            disabled={cannotSubmit}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.confirmBtnText}>
                {isUpdate ? "Confirm Update" : "Confirm Price"}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// DeclineModal
// ---------------------------------------------------------------------------

export type DeclineModalProps = {
  visible: boolean;
  sub: Submission;
  declineNote: string;
  declining: boolean;
  onNoteChange: (t: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  colors: any;
  styles: any;
};

export function DeclineModal({
  visible, sub, declineNote, declining,
  onNoteChange, onCancel, onConfirm,
  colors, styles,
}: DeclineModalProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => (declining ? null : onCancel())}
    >
      <View style={styles.reportModalBackdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => (declining ? null : onCancel())}
        />
        <View style={styles.reportModalCard}>
          <View style={styles.reportModalHeader}>
            <Ionicons name="close-circle-outline" size={22} color={colors.text} />
            <Text style={styles.reportModalTitle}>Cannot Offer</Text>
          </View>
          <Text style={styles.reportModalReport}>
            {sub.year} {sub.make_name} {sub.derivative_name || sub.model_name}
          </Text>
          <Text style={[styles.reportModalBody, { marginTop: spacing.sm }]}>
            This dealer will be notified:
          </Text>
          <View style={styles.declineQuote}>
            <Text style={styles.declineQuoteText}>
              &ldquo;We unfortunately are not able to make an offer on this vehicle,
              you will not be charged for the valuation.&rdquo;
            </Text>
          </View>
          <Text style={styles.reportModalBodySmall}>
            The dealer will not be charged the R50 valuation fee for this submission.
          </Text>

          <Text style={styles.label}>Internal note (optional — not shown to dealer)</Text>
          <TextInput
            testID="decline-note-input"
            style={[styles.priceInput, { minHeight: 64, textAlignVertical: "top" }]}
            value={declineNote}
            onChangeText={onNoteChange}
            placeholder="e.g. VIN mismatch, out-of-scope model, etc."
            placeholderTextColor={colors.textDisabled}
            multiline
          />

          <View style={styles.reportModalActions}>
            <TouchableOpacity
              testID="decline-cancel"
              style={styles.reportModalCancel}
              onPress={onCancel}
              disabled={declining}
            >
              <Text style={styles.reportModalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="decline-confirm"
              style={[styles.reportModalConfirm, declining && styles.docBtnDisabled]}
              onPress={onConfirm}
              disabled={declining}
            >
              {declining ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.reportModalConfirmText}>Confirm Decline</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
