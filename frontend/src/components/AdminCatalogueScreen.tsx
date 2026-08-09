import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Alert,
  Platform,
} from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";

type CatalogueModel = {
  name: string;
  enabled: boolean;
  submission_count: number;
};

type CatalogueMake = {
  name: string;
  enabled: boolean;
  submission_count: number;
  model_count: number;
  models: CatalogueModel[];
};

type CataloguePayload = {
  makes: CatalogueMake[];
  total_makes: number;
  enabled_makes: number;
};

/**
 * AdminCatalogueScreen — "Make Catalogue" tab under Web Admin Dashboard.
 *
 * The admin sees every make + model from the Kredo flatfile and can
 * toggle visibility for the dealer submission dropdown. Storage is
 * inverted (disabled sets) on the backend so an empty saved state
 * means "everything visible" — matches historical behaviour before
 * this feature shipped.
 *
 * UX rules:
 *  - Search filter narrows makes AND their models
 *  - Expanding a make row loads the inline model checklist
 *  - Bulk actions: Select all / Deselect all (respects current search)
 *  - Debounced auto-save on every toggle (patch is idempotent)
 *  - Warning icon on makes with live submissions
 */
export default function AdminCatalogueScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CataloguePayload | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/makes-catalogue");
      setData(res as CataloguePayload);
    } catch (e: any) {
      setError(e?.message || "Failed to load catalogue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Push the current disabled-sets to the backend. `nextData` is the
   * optimistic in-memory catalogue AFTER the toggle — we recompute the
   * disabled sets from it so the patch is trivially idempotent.
   */
  const persist = useCallback(async (nextData: CataloguePayload) => {
    const disabled_makes: string[] = [];
    const disabled_models: Record<string, string[]> = {};
    for (const mk of nextData.makes) {
      if (!mk.enabled) disabled_makes.push(mk.name);
      const disabledModelNames = mk.models.filter((m) => !m.enabled).map((m) => m.name);
      if (disabledModelNames.length > 0) {
        disabled_models[mk.name] = disabledModelNames;
      }
    }
    setSaving(true);
    try {
      await apiFetch("/api/admin/makes-catalogue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled_makes, disabled_models }),
      });
    } catch (e: any) {
      // Roll back the optimistic view on failure
      Alert.alert("Could not save catalogue", e?.message || "Please retry");
      load();
    } finally {
      setSaving(false);
    }
  }, [load]);

  const toggleMake = (name: string) => {
    if (!data) return;
    const next: CataloguePayload = {
      ...data,
      makes: data.makes.map((mk) =>
        mk.name === name ? { ...mk, enabled: !mk.enabled } : mk
      ),
    };
    next.enabled_makes = next.makes.filter((m) => m.enabled).length;
    setData(next);
    persist(next);
  };

  const toggleModel = (makeName: string, modelName: string) => {
    if (!data) return;
    const next: CataloguePayload = {
      ...data,
      makes: data.makes.map((mk) => {
        if (mk.name !== makeName) return mk;
        return {
          ...mk,
          models: mk.models.map((md) =>
            md.name === modelName ? { ...md, enabled: !md.enabled } : md
          ),
        };
      }),
    };
    setData(next);
    persist(next);
  };

  const toggleExpanded = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const filteredMakes = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.makes;
    return data.makes.filter((mk) => {
      if (mk.name.toLowerCase().includes(q)) return true;
      return mk.models.some((md) => md.name.toLowerCase().includes(q));
    });
  }, [data, search]);

  const setAllInFilter = (enabled: boolean) => {
    if (!data) return;
    const filterSet = new Set(filteredMakes.map((m) => m.name));
    const next: CataloguePayload = {
      ...data,
      makes: data.makes.map((mk) =>
        filterSet.has(mk.name) ? { ...mk, enabled } : mk
      ),
    };
    next.enabled_makes = next.makes.filter((m) => m.enabled).length;
    setData(next);
    persist(next);
  };

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.centreText}>Loading catalogue…</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.centre}>
        <Ionicons name="alert-circle" size={32} color={colors.danger} />
        <Text style={styles.centreText}>{error}</Text>
        <TouchableOpacity onPress={load} style={styles.retryBtn}>
          <Text style={styles.retryBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!data) return null;

  return (
    <View style={styles.container}>
      {/* Header + summary */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Make Catalogue</Text>
          <Text style={styles.subtitle}>
            {data.enabled_makes}/{data.total_makes} makes visible to dealers ·{" "}
            Toggle to hide makes/models from the vehicle submission dropdown
          </Text>
        </View>
        {saving && (
          <View style={styles.savingChip}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.savingText}>Saving…</Text>
          </View>
        )}
      </View>

      {/* Controls row */}
      <View style={styles.controls}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={14} color={colors.textSecondary} />
          <TextInput
            testID="catalogue-search"
            value={search}
            onChangeText={setSearch}
            placeholder="Search makes or models…"
            placeholderTextColor={colors.textDisabled}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch("")} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          testID="catalogue-select-all"
          onPress={() => setAllInFilter(true)}
          style={[styles.bulkBtn, { borderColor: colors.success }]}
        >
          <Ionicons name="checkmark-done" size={14} color={colors.success} />
          <Text style={[styles.bulkBtnText, { color: colors.success }]}>
            Enable {search ? "filtered" : "all"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="catalogue-deselect-all"
          onPress={() => setAllInFilter(false)}
          style={[styles.bulkBtn, { borderColor: colors.danger }]}
        >
          <Ionicons name="close" size={14} color={colors.danger} />
          <Text style={[styles.bulkBtnText, { color: colors.danger }]}>
            Disable {search ? "filtered" : "all"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Make list */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, paddingTop: 0 }}>
        {filteredMakes.length === 0 ? (
          <View style={[styles.centre, { paddingVertical: spacing.xl }]}>
            <Text style={styles.centreText}>No matching makes.</Text>
          </View>
        ) : (
          filteredMakes.map((mk) => {
            const isExpanded = expanded.has(mk.name);
            const enabledModelCount = mk.models.filter((m) => m.enabled).length;
            const q = search.trim().toLowerCase();
            const visibleModels = q
              ? mk.models.filter(
                  (md) =>
                    mk.name.toLowerCase().includes(q) ||
                    md.name.toLowerCase().includes(q)
                )
              : mk.models;
            return (
              <View key={mk.name} style={styles.makeCard}>
                {/* Row header */}
                <View style={styles.makeRow}>
                  <TouchableOpacity
                    testID={`catalogue-make-toggle-${mk.name}`}
                    onPress={() => toggleMake(mk.name)}
                    style={styles.checkboxTap}
                    hitSlop={8}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        mk.enabled && styles.checkboxOn,
                      ]}
                    >
                      {mk.enabled && (
                        <Ionicons name="checkmark" size={14} color="#fff" />
                      )}
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => toggleExpanded(mk.name)}
                    style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}
                  >
                    <Text
                      style={[
                        styles.makeName,
                        !mk.enabled && { color: colors.textDisabled, textDecorationLine: "line-through" },
                      ]}
                    >
                      {mk.name}
                    </Text>
                    <Text style={styles.modelCount}>
                      {enabledModelCount}/{mk.model_count} models
                    </Text>
                    {mk.submission_count > 0 && (
                      <View style={styles.subsChip}>
                        <Ionicons name="documents" size={10} color={colors.textSecondary} />
                        <Text style={styles.subsChipText}>{mk.submission_count} live</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => toggleExpanded(mk.name)} hitSlop={8}>
                    <Ionicons
                      name={isExpanded ? "chevron-up" : "chevron-down"}
                      size={18}
                      color={colors.textSecondary}
                    />
                  </TouchableOpacity>
                </View>

                {/* Model list */}
                {isExpanded && (
                  <View style={styles.modelList}>
                    {visibleModels.length === 0 ? (
                      <Text style={styles.emptyModelText}>No matching models.</Text>
                    ) : (
                      visibleModels.map((md) => (
                        <TouchableOpacity
                          key={md.name}
                          testID={`catalogue-model-toggle-${mk.name}-${md.name}`}
                          onPress={() => toggleModel(mk.name, md.name)}
                          style={styles.modelRow}
                          hitSlop={4}
                        >
                          <View
                            style={[
                              styles.checkbox,
                              styles.checkboxSm,
                              md.enabled && mk.enabled && styles.checkboxOn,
                              !mk.enabled && styles.checkboxDisabled,
                            ]}
                          >
                            {md.enabled && mk.enabled && (
                              <Ionicons name="checkmark" size={11} color="#fff" />
                            )}
                          </View>
                          <Text
                            style={[
                              styles.modelName,
                              (!md.enabled || !mk.enabled) && {
                                color: colors.textDisabled,
                                textDecorationLine: "line-through",
                              },
                            ]}
                          >
                            {md.name}
                          </Text>
                          {md.submission_count > 0 && (
                            <Text style={styles.modelSubs}>
                              {md.submission_count}
                            </Text>
                          )}
                        </TouchableOpacity>
                      ))
                    )}
                  </View>
                )}
              </View>
            );
          })
        )}

        <View style={{ height: spacing.xl }} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centre: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      gap: spacing.md,
      padding: spacing.lg,
    },
    centreText: { color: colors.textSecondary, fontSize: 13, textAlign: "center" },
    retryBtn: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: radius.sm,
      backgroundColor: colors.primary,
    },
    retryBtnText: { color: colors.onPrimary, fontWeight: "800" },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
    },
    title: { fontSize: 20, fontWeight: "900", color: colors.text, ...(fonts?.heading || {}) },
    subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
    savingChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: radius.sm,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    savingText: { color: colors.textSecondary, fontSize: 11, fontWeight: "700" },
    controls: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.sm,
      flexWrap: "wrap" as const,
    },
    searchBox: {
      flex: 1,
      minWidth: 200,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: Platform.OS === "web" ? 8 : 6,
      borderRadius: radius.sm,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    searchInput: {
      flex: 1,
      color: colors.text,
      fontSize: 13,
      ...(Platform.OS === "web" ? ({ outlineStyle: "none" as any } as any) : {}),
    },
    bulkBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: radius.sm,
      borderWidth: 1,
      backgroundColor: colors.surface,
    },
    bulkBtnText: { fontSize: 11, fontWeight: "800" },
    makeCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.sm,
      backgroundColor: colors.surface,
      marginBottom: 8,
    },
    makeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    checkboxTap: { padding: 2 },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: colors.border,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: colors.bg,
    },
    checkboxSm: { width: 16, height: 16, borderRadius: 3 },
    checkboxOn: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    checkboxDisabled: { opacity: 0.45 },
    makeName: { fontSize: 14, fontWeight: "800", color: colors.text },
    modelCount: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.textSecondary,
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    subsChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
    },
    subsChipText: { fontSize: 10, fontWeight: "700", color: colors.textSecondary },
    modelList: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      padding: 10,
      paddingLeft: 42,
      gap: 6,
    },
    modelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 4,
    },
    modelName: { flex: 1, color: colors.text, fontSize: 13, fontWeight: "600" },
    modelSubs: {
      fontSize: 10,
      color: colors.textSecondary,
      fontWeight: "700",
      minWidth: 20,
      textAlign: "right",
    },
    emptyModelText: { color: colors.textSecondary, fontSize: 12, fontStyle: "italic" },
  });
