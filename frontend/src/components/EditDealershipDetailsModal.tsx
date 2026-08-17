/**
 * EditDealershipDetailsModal — shared modal for editing every
 * dealership-level field (name, address, VAT / reg numbers, and the
 * billing accounts contact block). Aug 2026.
 *
 * Used from:
 *  • Admin Billing Cockpit → wallet card → "Edit dealership" pill
 *  • Admin Dealers screen  → group header → "Edit details" pill
 *
 * The modal is fully self-contained: pass the current dealership doc
 * (or a stub with just `id`), an onSaved callback and it PATCHes
 * `/api/admin/dealerships/{id}` and closes on success.
 */
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, Modal, Pressable, ScrollView, TextInput, StyleSheet, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { useThemeColors } from "@/src/theme/ThemeContext";
import { spacing, radius, fonts } from "@/src/theme";
import { apiFetch } from "@/src/api";

type Contact = { name?: string | null; phone?: string | null; email?: string | null };
type DealershipStub = {
  id: string;
  name?: string;
  address?: string;
  company_reg_no?: string | null;
  vat_no?: string | null;
  accounts_contact?: Contact;
};

export default function EditDealershipDetailsModal({
  open, onClose, dealership, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  dealership: DealershipStub | null;
  onSaved?: () => void;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [values, setValues] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !dealership) return;
    // If the caller passed a stub with just the id (e.g. from a group
    // header where we only have id+name), fetch the fresh doc from the
    // billing-summary endpoint so we know the current accounts_contact.
    setLoadError(null);
    (async () => {
      let d: any = dealership;
      const needsFetch = !d.address && !d.accounts_contact;
      if (needsFetch) {
        try {
          const res = await apiFetch(`/api/admin/dealerships/${d.id}/billing-summary`);
          d = { ...d, ...(res?.dealership || {}) };
        } catch (e: any) {
          setLoadError(e?.message || "Could not fetch dealership details.");
        }
      }
      const c = d?.accounts_contact || {};
      setValues({
        name: d?.name || "",
        address: d?.address || "",
        company_reg_no: d?.company_reg_no || "",
        vat_no: d?.vat_no || "",
        accounts_contact_name: c.name || "",
        accounts_contact_phone: c.phone || "",
        accounts_contact_email: c.email || "",
      });
    })();
  }, [open, dealership]);

  const set = (k: string, v: any) => setValues((s: any) => ({ ...s, [k]: v }));

  const save = async () => {
    if (!dealership) return;
    if (!values.name?.trim()) { Alert.alert("Name is required"); return; }
    setBusy(true);
    try {
      await apiFetch(`/api/admin/dealerships/${dealership.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: values.name.trim(),
          address: values.address?.trim(),
          company_reg_no: values.company_reg_no?.trim() || null,
          vat_no: values.vat_no?.trim() || null,
          accounts_contact_name: values.accounts_contact_name?.trim() || null,
          accounts_contact_phone: values.accounts_contact_phone?.trim() || null,
          accounts_contact_email: values.accounts_contact_email?.trim() || null,
        }),
      });
      onSaved?.();
      onClose();
      Alert.alert("Saved", "Dealership details updated.");
    } catch (e: any) {
      Alert.alert("Failed", e?.message || "");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBg} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e: any) => e.stopPropagation && e.stopPropagation()}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Edit Dealership Details</Text>
            <TouchableOpacity testID="edit-dealership-modal-close" onPress={onClose}>
              <Ionicons name="close" size={18} color={colors.text} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: spacing.md }}>
            <Text style={styles.hint}>
              These details appear on every invoice, deposit request and statement PDF for this dealership. The accounts contact receives all billing email correspondence.
            </Text>
            {loadError ? <Text style={styles.errorText}>{loadError}</Text> : null}
            <Field label="Dealership name" value={values.name} onChangeText={(v: string) => set("name", v)} styles={styles} testID="edit-dealership-name" />
            <Field label="Address" value={values.address} onChangeText={(v: string) => set("address", v)} multiline styles={styles} />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Field label="Company reg no." value={values.company_reg_no} onChangeText={(v: string) => set("company_reg_no", v)} styles={styles} style={{ flex: 1 }} />
              <Field label="VAT no." value={values.vat_no} onChangeText={(v: string) => set("vat_no", v)} styles={styles} style={{ flex: 1 }} />
            </View>
            <Text style={[styles.formLabel, { marginTop: spacing.md, marginBottom: 6 }]}>ACCOUNTS CONTACT</Text>
            <Field label="Full name" value={values.accounts_contact_name} onChangeText={(v: string) => set("accounts_contact_name", v)} styles={styles} placeholder="e.g. Jane Smith" testID="edit-dealership-contact-name" />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Field label="Phone" value={values.accounts_contact_phone} onChangeText={(v: string) => set("accounts_contact_phone", v)} keyboardType="phone-pad" styles={styles} style={{ flex: 1 }} placeholder="+27 82 …" />
              <Field label="Email" value={values.accounts_contact_email} onChangeText={(v: string) => set("accounts_contact_email", v)} keyboardType="email-address" styles={styles} style={{ flex: 1 }} placeholder="accounts@…" />
            </View>
            <TouchableOpacity
              testID="edit-dealership-submit"
              style={[styles.primaryBtn, busy && { opacity: 0.6 }]}
              disabled={busy}
              onPress={save}
            >
              <Text style={styles.primaryBtnText}>{busy ? "Saving…" : "Save"}</Text>
            </TouchableOpacity>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Field({ label, value, onChangeText, keyboardType, multiline, placeholder, styles, style, testID }: any) {
  return (
    <View style={[{ marginBottom: 10 }, style]}>
      <Text style={styles.formLabel}>{label}</Text>
      <TextInput
        testID={testID}
        style={[styles.formInput, multiline && { minHeight: 60, textAlignVertical: "top" }]}
        value={value == null ? "" : String(value)}
        onChangeText={onChangeText}
        keyboardType={keyboardType || "default"}
        placeholder={placeholder}
        placeholderTextColor="#94A3B8"
        multiline={!!multiline}
      />
    </View>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", alignItems: "center", justifyContent: "center", padding: spacing.md },
    modalCard: { width: "min(640px, 92vw)" as any, maxHeight: "85vh" as any, backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.borderLight },
    modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
    modalTitle: { color: colors.text, fontSize: 15, fontWeight: "800", letterSpacing: 0.4, fontFamily: fonts.body },
    hint: { color: colors.textSecondary, fontSize: 11, lineHeight: 16, marginBottom: spacing.sm, fontStyle: "italic" },
    formLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "700", letterSpacing: 0.4, marginBottom: 3 },
    formInput: { color: colors.text, fontSize: 13, paddingVertical: 8, paddingHorizontal: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderLight, backgroundColor: colors.background },
    errorText: { color: "#B91C1C", fontSize: 11, marginBottom: spacing.sm },
    primaryBtn: { marginTop: spacing.md, alignItems: "center", justifyContent: "center", paddingVertical: 12, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.primary },
    primaryBtnText: { color: colors.onPrimary || "#fff", fontSize: 14, fontWeight: "800", letterSpacing: 0.3 },
  });
