// -----------------------------------------------------------------------------
// SupplierListSection — dealership-scoped recon supplier catalog.
//
// Only rendered for users with managerial access (backend flag
// `is_pricing_agent`). The parent (Profile screen) is responsible for
// the render guard; this component assumes it should show.
//
// Provides:
//   * List of active suppliers with tap-to-edit
//   * "Add supplier" button opening a modal with fields:
//       - Name of Supplier
//       - Contact Name
//       - Contact Number
//       - Categories of Work (multi-select checkboxes)
//   * Edit modal (reuses the add modal in edit mode)
//   * Delete (soft-delete) confirmation
//
// Once assigned to a submission's recon line item, a snapshot of the
// supplier's core fields is stored on the submission so the recon PDF
// keeps rendering the supplier even if the supplier is later deleted.
// -----------------------------------------------------------------------------
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, Modal, ScrollView, ActivityIndicator, Alert,
} from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import { apiFetch } from "@/src/api";
import { confirmAsync } from "@/src/utils/vehicle-detail";
import type { Palette } from "@/src/theme/ThemeContext";

export type Supplier = {
  id: string;
  name: string;
  contact_name?: string | null;
  contact_phone?: string | null;
  categories: string[];
};

export type SupplierListSectionProps = {
  colors: Palette;
  // Show / hide the add/edit/delete affordances. False = read-only mode
  // for non-managerial users on the same dealership.
  canEdit?: boolean;
  // When rendered on its own screen (Home → Suppliers) the outer wrapper
  // already provides padding, and we want the list ALWAYS expanded
  // instead of collapsible. Set `mode="page"` to switch behaviour.
  mode?: "profile" | "page";
};

export default function SupplierListSection({ colors, canEdit = true, mode = "profile" }: SupplierListSectionProps) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const isPageMode = mode === "page";
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Supplier[]>([]);
  const [categoryEnum, setCategoryEnum] = useState<string[]>([]);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [adding, setAdding] = useState(false);
  // Collapsible: closed by default on the Profile screen; always open
  // when rendered as its own page (Home → Suppliers).
  const [open, setOpen] = useState(isPageMode);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch("/api/suppliers");
      setItems(r.suppliers || []);
      setCategoryEnum(r.categories || []);
    } catch (e: any) {
      Alert.alert("Suppliers", e?.message || "Could not load suppliers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const closeModal = () => { setEditing(null); setAdding(false); };

  const handleDelete = async (s: Supplier) => {
    // Alert.alert with 3 buttons silently drops on RN Web — use the
    // cross-platform confirmAsync helper so the dustbin actually works
    // in the web preview and native builds alike.
    const proceed = await confirmAsync(
      "Delete supplier?",
      `Remove "${s.name}" from your supplier list? Suppliers already assigned to a submission's recon lines stay on those PDFs.`,
      "Delete",
    );
    if (!proceed) return;
    try {
      await apiFetch(`/api/suppliers/${s.id}`, { method: "DELETE" });
      setItems((prev) => prev.filter((x) => x.id !== s.id));
    } catch (e: any) {
      Alert.alert("Delete", e?.message || "Could not delete supplier");
    }
  };

  return (
    <View style={styles.section}>
      {isPageMode ? (
        <View style={styles.sectionHeader}>
          <View style={{ flex: 1 }}>
            <View style={styles.titleRow}>
              <Text style={styles.sectionTitle}>Recon Suppliers</Text>
              {items.length > 0 ? (
                <View style={styles.countBadge}>
                  <Text style={styles.countBadgeText}>{items.length}</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.sectionSub}>
              {canEdit
                ? "Shared across your dealership. Assign one per reconditioning line item after a deal is done — the printed Reconditioning Sheet shows who's doing the work."
                : "Your dealership's supplier catalog (read-only). Only managerial users can add, edit or remove entries."}
            </Text>
          </View>
          {canEdit ? (
            <TouchableOpacity
              testID="add-supplier-btn"
              style={styles.addBtn}
              onPress={() => setAdding(true)}
              accessibilityRole="button"
            >
              <Ionicons name="add" size={16} color={colors.onPrimary} />
              <Text style={styles.addBtnText}>Add</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <TouchableOpacity
          testID="supplier-section-toggle"
          activeOpacity={0.7}
          onPress={() => setOpen((v) => !v)}
          style={styles.sectionHeader}
          accessibilityRole="button"
          accessibilityLabel={open ? "Collapse Recon Suppliers" : "Expand Recon Suppliers"}
        >
          <View style={{ flex: 1 }}>
            <View style={styles.titleRow}>
              <Ionicons
                name={open ? "chevron-up" : "chevron-down"}
                size={16}
                color={colors.textSecondary}
              />
              <Text style={styles.sectionTitle}>Recon Suppliers</Text>
              {items.length > 0 ? (
                <View style={styles.countBadge}>
                  <Text style={styles.countBadgeText}>{items.length}</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.sectionSub}>
              Shared across your dealership. Assign a supplier to each reconditioning
              line item on any submission after the deal is done — the printed
              Reconditioning Sheet will show who&apos;s doing the work.
            </Text>
          </View>
          {canEdit ? (
            <TouchableOpacity
              testID="add-supplier-btn"
              style={styles.addBtn}
              onPress={(e: any) => {
                e?.stopPropagation?.();
                setOpen(true);
                setAdding(true);
              }}
              accessibilityRole="button"
            >
              <Ionicons name="add" size={16} color={colors.onPrimary} />
              <Text style={styles.addBtnText}>Add</Text>
            </TouchableOpacity>
          ) : null}
        </TouchableOpacity>
      )}

      {open ? (
        loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={colors.textSecondary} size="small" />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="briefcase-outline" size={22} color={colors.textDisabled} />
            <Text style={styles.emptyText}>
              {canEdit
                ? "No suppliers yet. Add your workshops so you can assign them per recon line on future deals."
                : "No suppliers yet. Ask a managerial user at your dealership to add your regular workshops."}
            </Text>
          </View>
        ) : (
          items.map((s, idx) => (
            <View
              key={s.id}
              style={[styles.row, idx === items.length - 1 && { borderBottomWidth: 0 }]}
              testID={`supplier-row-${s.id}`}
            >
              <View style={{ flex: 1, minWidth: 0, marginRight: spacing.sm }}>
                <Text style={styles.rowName} numberOfLines={1}>{s.name}</Text>
                {s.contact_name || s.contact_phone ? (
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {[s.contact_name, s.contact_phone].filter(Boolean).join(" · ")}
                  </Text>
                ) : null}
                {s.categories?.length ? (
                  <View style={styles.chipRow}>
                    {s.categories.map((c) => (
                      <View key={c} style={styles.chip}>
                        <Text style={styles.chipText}>{c}</Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={[styles.rowMeta, { fontStyle: "italic" }]}>No categories set</Text>
                )}
              </View>
              {canEdit ? (
                <>
                  <TouchableOpacity
                    testID={`supplier-edit-${s.id}`}
                    onPress={() => setEditing(s)}
                    style={styles.iconBtn}
                  >
                    <Ionicons name="pencil" size={16} color={colors.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID={`supplier-delete-${s.id}`}
                    onPress={() => handleDelete(s)}
                    style={styles.iconBtn}
                  >
                    <Ionicons name="trash-outline" size={16} color={colors.danger} />
                  </TouchableOpacity>
                </>
              ) : null}
            </View>
          ))
        )
      ) : null}

      {/* Add / Edit modal */}
      <SupplierFormModal
        visible={adding || editing !== null}
        initial={editing}
        categoryEnum={categoryEnum}
        colors={colors}
        onClose={closeModal}
        onSaved={(saved) => {
          setItems((prev) => {
            const idx = prev.findIndex((x) => x.id === saved.id);
            if (idx === -1) return [...prev, saved].sort((a, b) => a.name.localeCompare(b.name));
            const copy = [...prev];
            copy[idx] = saved;
            return copy;
          });
          closeModal();
        }}
      />
    </View>
  );
}

// -----------------------------------------------------------------------------
// SupplierFormModal — add + edit in the same component.
// -----------------------------------------------------------------------------
function SupplierFormModal({
  visible,
  initial,
  categoryEnum,
  colors,
  onClose,
  onSaved,
}: {
  visible: boolean;
  initial: Supplier | null;
  categoryEnum: string[];
  colors: Palette;
  onClose: () => void;
  onSaved: (s: Supplier) => void;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setName(initial?.name || "");
      setContactName(initial?.contact_name || "");
      setContactPhone(initial?.contact_phone || "");
      setCategories(initial?.categories || []);
    }
  }, [visible, initial]);

  const toggleCategory = (c: string) => {
    setCategories((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  const submit = async () => {
    if (!name.trim()) {
      Alert.alert("Supplier", "Supplier name is required.");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        contact_name: contactName.trim() || null,
        contact_phone: contactPhone.trim() || null,
        categories,
      };
      const r = initial
        ? await apiFetch(`/api/suppliers/${initial.id}`, { method: "PUT", body: JSON.stringify(body) })
        : await apiFetch(`/api/suppliers`, { method: "POST", body: JSON.stringify(body) });
      onSaved(r.supplier);
    } catch (e: any) {
      Alert.alert("Supplier", e?.message || "Could not save supplier");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{initial ? "Edit Supplier" : "Add Supplier"}</Text>
            <TouchableOpacity onPress={onClose} testID="supplier-form-close">
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: spacing.md }}>
            <Text style={styles.fieldLabel}>Supplier Name *</Text>
            <TextInput
              testID="supplier-name-input"
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Fourways Windscreens"
              placeholderTextColor={colors.textDisabled}
            />
            <Text style={styles.fieldLabel}>Contact Name</Text>
            <TextInput
              testID="supplier-contact-name-input"
              style={styles.input}
              value={contactName}
              onChangeText={setContactName}
              placeholder="Person to speak to"
              placeholderTextColor={colors.textDisabled}
            />
            <Text style={styles.fieldLabel}>Contact Number</Text>
            <TextInput
              testID="supplier-contact-phone-input"
              style={styles.input}
              value={contactPhone}
              onChangeText={setContactPhone}
              placeholder="e.g. 082 555 1234"
              placeholderTextColor={colors.textDisabled}
              keyboardType="phone-pad"
            />
            <Text style={styles.fieldLabel}>Categories of Work</Text>
            <Text style={styles.fieldHint}>
              Select every reconditioning category this supplier can cover.
            </Text>
            {categoryEnum.map((c) => {
              const active = categories.includes(c);
              return (
                <TouchableOpacity
                  key={c}
                  testID={`supplier-cat-${c}`}
                  style={styles.catRow}
                  onPress={() => toggleCategory(c)}
                >
                  <View style={[styles.checkbox, active && styles.checkboxActive]}>
                    {active ? <Ionicons name="checkmark" size={13} color="#fff" /> : null}
                  </View>
                  <Text style={styles.catLabel}>{c}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <View style={styles.modalFooter}>
            <TouchableOpacity onPress={onClose} style={styles.footerBtn} testID="supplier-cancel">
              <Text style={styles.footerBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={submit}
              disabled={saving}
              style={[styles.footerBtn, styles.footerPrimary, saving && { opacity: 0.6 }]}
              testID="supplier-save"
            >
              {saving ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Text style={[styles.footerBtnText, { color: colors.onPrimary }]}>
                  {initial ? "Save changes" : "Add supplier"}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// -----------------------------------------------------------------------------
function makeStyles(colors: Palette) {
  return StyleSheet.create({
    section: {
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      padding: spacing.lg,
      marginBottom: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    sectionHeader: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      marginBottom: spacing.md,
    },
    titleRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      marginBottom: 4,
    },
    countBadge: {
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 7,
      paddingVertical: 1,
      borderRadius: 999,
    },
    countBadgeText: {
      color: colors.textSecondary,
      fontSize: 10,
      fontWeight: "800" as const,
      letterSpacing: 0.4,
    },
    sectionTitle: {
      color: colors.text,
      fontSize: 16,
      fontWeight: "700" as const,
      fontFamily: fonts.heading,
    },
    sectionSub: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
    },
    addBtn: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 3,
      backgroundColor: colors.primary,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 999,
      marginLeft: spacing.md,
    },
    addBtnText: {
      color: colors.onPrimary,
      fontSize: 12,
      fontWeight: "800" as const,
    },
    loadingBox: {
      paddingVertical: spacing.lg,
      alignItems: "center" as const,
    },
    emptyBox: {
      padding: spacing.md,
      alignItems: "center" as const,
      backgroundColor: colors.bg,
      borderRadius: radius.md,
    },
    emptyText: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
      marginTop: 4,
      textAlign: "center" as const,
    },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    rowName: {
      color: colors.text,
      fontSize: 14,
      fontWeight: "700" as const,
    },
    rowMeta: {
      color: colors.textSecondary,
      fontSize: 12,
      marginTop: 2,
    },
    chipRow: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 4,
      marginTop: 6,
    },
    chip: {
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 999,
    },
    chipText: {
      color: colors.textSecondary,
      fontSize: 10,
      fontWeight: "700" as const,
    },
    iconBtn: {
      width: 32,
      height: 32,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    /* --- Modal --- */
    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "center" as const,
      padding: spacing.lg,
    },
    modalCard: {
      backgroundColor: colors.card,
      borderRadius: radius.lg,
      maxHeight: "90%",
      padding: spacing.lg,
    },
    modalHeader: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      marginBottom: spacing.md,
    },
    modalTitle: {
      color: colors.text,
      fontSize: 18,
      fontWeight: "800" as const,
      fontFamily: fonts.heading,
    },
    fieldLabel: {
      color: colors.text,
      fontSize: 12,
      fontWeight: "700" as const,
      marginTop: spacing.md,
      marginBottom: 4,
      textTransform: "uppercase" as const,
      letterSpacing: 0.4,
    },
    fieldHint: {
      color: colors.textSecondary,
      fontSize: 11,
      marginBottom: 6,
    },
    input: {
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.sm,
      paddingVertical: 10,
      color: colors.text,
      fontSize: 14,
    },
    catRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingVertical: 8,
      gap: spacing.sm,
    },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 4,
      borderWidth: 2,
      borderColor: colors.border,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    checkboxActive: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    catLabel: {
      color: colors.text,
      fontSize: 14,
    },
    modalFooter: {
      flexDirection: "row" as const,
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    footerBtn: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: radius.md,
      backgroundColor: colors.bg,
      alignItems: "center" as const,
    },
    footerPrimary: {
      backgroundColor: colors.primary,
    },
    footerBtnText: {
      color: colors.text,
      fontSize: 14,
      fontWeight: "700" as const,
    },
  });
}
