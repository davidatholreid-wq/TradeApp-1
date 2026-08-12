// -----------------------------------------------------------------------------
// AssignSuppliersModal — modal shown from the Deal Tracking card that
// lets a managerial user pair each reconditioning line item with a
// supplier from their dealership's supplier catalog.
//
// Layout:
//   - Modal header with title + close
//   - One row per recon line: category/label + amount on top, supplier
//     dropdown/picker on the bottom
//   - Save cascades a POST-per-changed-line to the backend
// -----------------------------------------------------------------------------
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, Modal, ScrollView, ActivityIndicator, Alert,
} from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import { apiFetch } from "@/src/api";
import type { Palette } from "@/src/theme/ThemeContext";

export type Supplier = {
  id: string;
  name: string;
  contact_name?: string | null;
  contact_phone?: string | null;
  categories: string[];
};

export type ReconLineForAssignment = {
  index: number;
  category?: string | null;
  label?: string | null;
  amount_zar?: number | null;
  // Snapshot of the currently-assigned supplier (may be null).
  supplier?: {
    id?: string;
    name?: string;
    contact_name?: string | null;
    contact_phone?: string | null;
  } | null;
};

export type AssignSuppliersModalProps = {
  visible: boolean;
  onClose: () => void;
  submissionId: string;
  reconItems: ReconLineForAssignment[];
  colors: Palette;
  // Called after a supplier is assigned/cleared so the parent can
  // refresh its own copy of the submission (updates the recon PDF
  // button state, the visible supplier chip, etc.)
  onAssignmentsChanged: () => void;
};

export default function AssignSuppliersModal({
  visible,
  onClose,
  submissionId,
  reconItems,
  colors,
  onAssignmentsChanged,
}: AssignSuppliersModalProps) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [saving, setSaving] = useState<number | null>(null);
  // Which line index is currently expanded to show the picker
  const [pickerOpenFor, setPickerOpenFor] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch("/api/suppliers");
      setSuppliers(r.suppliers || []);
    } catch (e: any) {
      Alert.alert("Suppliers", e?.message || "Could not load suppliers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      load();
      setPickerOpenFor(null);
    }
  }, [visible, load]);

  const assign = async (lineIndex: number, supplierId: string | null) => {
    setSaving(lineIndex);
    try {
      await apiFetch(
        `/api/submissions/${submissionId}/reconditioning/${lineIndex}/supplier`,
        {
          method: "POST",
          body: JSON.stringify({ supplier_id: supplierId }),
        },
      );
      onAssignmentsChanged();
      setPickerOpenFor(null);
    } catch (e: any) {
      Alert.alert("Assign supplier", e?.message || "Could not assign supplier");
    } finally {
      setSaving(null);
    }
  };

  const fmtZar = (v: number | null | undefined) =>
    v == null ? "" : `R ${Math.round(v).toLocaleString()}`;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Assign Suppliers</Text>
              <Text style={styles.subtitle}>
                Pick who will carry out each reconditioning line. Suppliers
                are managed on your Profile screen.
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} testID="assign-suppliers-close">
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.textSecondary} size="small" />
            </View>
          ) : reconItems.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>
                No reconditioning items captured on this submission.
              </Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ paddingBottom: spacing.md }}>
              {reconItems.map((item) => {
                const heading = item.category || item.label || "Reconditioning";
                const eligible = suppliers.filter(
                  (s) => !item.category || s.categories.includes(item.category),
                );
                // If there are suppliers whose category doesn't match this
                // line, keep them accessible via a "Show all" toggle so the
                // dealer isn't blocked by category mismatches.
                const nonEligibleCount = suppliers.length - eligible.length;
                const isOpen = pickerOpenFor === item.index;
                const assigned = item.supplier || null;
                return (
                  <View
                    key={item.index}
                    style={styles.line}
                    testID={`assign-line-${item.index}`}
                  >
                    <View style={styles.lineHeader}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.lineHeading} numberOfLines={1}>{heading}</Text>
                        {item.amount_zar != null ? (
                          <Text style={styles.lineAmount}>{fmtZar(item.amount_zar)}</Text>
                        ) : null}
                      </View>
                    </View>
                    {assigned && assigned.name ? (
                      <View style={styles.assignedRow}>
                        <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.assignedName} numberOfLines={1}>{assigned.name}</Text>
                          {(assigned.contact_name || assigned.contact_phone) ? (
                            <Text style={styles.assignedMeta} numberOfLines={1}>
                              {[assigned.contact_name, assigned.contact_phone]
                                .filter(Boolean)
                                .join(" · ")}
                            </Text>
                          ) : null}
                        </View>
                        <TouchableOpacity
                          testID={`assign-clear-${item.index}`}
                          onPress={() => assign(item.index, null)}
                          disabled={saving === item.index}
                          style={styles.clearBtn}
                        >
                          {saving === item.index ? (
                            <ActivityIndicator size="small" color={colors.textSecondary} />
                          ) : (
                            <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
                          )}
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <Text style={styles.emptyAssigned}>
                        No supplier assigned yet.
                      </Text>
                    )}

                    <TouchableOpacity
                      testID={`assign-picker-toggle-${item.index}`}
                      onPress={() => setPickerOpenFor(isOpen ? null : item.index)}
                      style={styles.pickerToggle}
                    >
                      <Ionicons
                        name={isOpen ? "chevron-up" : "chevron-down"}
                        size={13}
                        color={colors.primary}
                      />
                      <Text style={styles.pickerToggleText}>
                        {isOpen ? "Hide list" : (assigned && assigned.name ? "Change supplier" : "Select supplier")}
                      </Text>
                    </TouchableOpacity>

                    {isOpen ? (
                      <View style={styles.picker}>
                        {eligible.length === 0 && nonEligibleCount === 0 ? (
                          <Text style={styles.pickerEmpty}>
                            No suppliers yet. Add some on your Profile screen.
                          </Text>
                        ) : eligible.length === 0 ? (
                          <Text style={styles.pickerEmpty}>
                            No suppliers for &ldquo;{item.category || "this category"}&rdquo;.
                            Showing your entire catalog below.
                          </Text>
                        ) : null}
                        {(eligible.length ? eligible : suppliers).map((s) => {
                          const isSelected = assigned?.id === s.id;
                          return (
                            <TouchableOpacity
                              key={s.id}
                              testID={`assign-pick-${item.index}-${s.id}`}
                              onPress={() => assign(item.index, s.id)}
                              disabled={saving === item.index}
                              style={[styles.pickerRow, isSelected && styles.pickerRowActive]}
                            >
                              <View style={{ flex: 1, minWidth: 0 }}>
                                <Text style={styles.pickerName} numberOfLines={1}>{s.name}</Text>
                                {s.contact_name || s.contact_phone ? (
                                  <Text style={styles.pickerMeta} numberOfLines={1}>
                                    {[s.contact_name, s.contact_phone].filter(Boolean).join(" · ")}
                                  </Text>
                                ) : null}
                              </View>
                              {isSelected ? (
                                <Ionicons name="checkmark-circle" size={16} color={colors.primary} />
                              ) : null}
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          )}

          <TouchableOpacity onPress={onClose} style={styles.doneBtn} testID="assign-suppliers-done">
            <Text style={styles.doneBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// -----------------------------------------------------------------------------
function makeStyles(colors: Palette) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "center" as const,
      padding: spacing.lg,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      maxHeight: "90%",
      padding: spacing.lg,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      marginBottom: spacing.md,
    },
    title: {
      color: colors.text,
      fontSize: 18,
      fontWeight: "800" as const,
      fontFamily: fonts.heading,
      marginBottom: 2,
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
    },
    loadingBox: {
      paddingVertical: spacing.lg,
      alignItems: "center" as const,
    },
    emptyBox: {
      padding: spacing.md,
      alignItems: "center" as const,
    },
    emptyText: {
      color: colors.textSecondary,
      fontSize: 13,
    },
    line: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.sm,
    },
    lineHeader: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
    },
    lineHeading: {
      color: colors.text,
      fontSize: 14,
      fontWeight: "700" as const,
    },
    lineAmount: {
      color: colors.textSecondary,
      fontSize: 12,
      marginTop: 2,
    },
    assignedRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      marginTop: 8,
      padding: 8,
      backgroundColor: colors.success + "22",
      borderRadius: radius.md,
    },
    assignedName: {
      color: colors.text,
      fontSize: 13,
      fontWeight: "700" as const,
    },
    assignedMeta: {
      color: colors.textSecondary,
      fontSize: 11,
      marginTop: 1,
    },
    clearBtn: {
      width: 26,
      height: 26,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    emptyAssigned: {
      color: colors.textDisabled,
      fontSize: 12,
      fontStyle: "italic" as const,
      marginTop: 6,
    },
    pickerToggle: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
      marginTop: 8,
    },
    pickerToggleText: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: "700" as const,
    },
    picker: {
      marginTop: 8,
      backgroundColor: colors.card,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    pickerRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    pickerRowActive: {
      backgroundColor: colors.primary + "18",
    },
    pickerName: {
      color: colors.text,
      fontSize: 13,
      fontWeight: "700" as const,
    },
    pickerMeta: {
      color: colors.textSecondary,
      fontSize: 11,
      marginTop: 1,
    },
    pickerEmpty: {
      color: colors.textSecondary,
      fontSize: 12,
      padding: 10,
      fontStyle: "italic" as const,
    },
    doneBtn: {
      marginTop: spacing.md,
      paddingVertical: 12,
      borderRadius: radius.md,
      backgroundColor: colors.primary,
      alignItems: "center" as const,
    },
    doneBtnText: {
      color: colors.onPrimary,
      fontSize: 14,
      fontWeight: "800" as const,
    },
  });
}
