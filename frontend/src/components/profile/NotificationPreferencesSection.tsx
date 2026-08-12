// -----------------------------------------------------------------------------
// NotificationPreferencesSection — per-type push notification toggles.
//
// Fetches the current preference catalog from `/api/notifications/preferences`
// on mount, renders one toggle row per key, and PUTs the updated map back
// on every change. Failure to persist re-throws so the caller sees the
// toast; local state is optimistically updated for snappy UX.
// -----------------------------------------------------------------------------
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Switch, ActivityIndicator, Alert, Platform, Linking } from "react-native";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { Ionicons } from "@expo/vector-icons";
import * as Notifications from "expo-notifications";
import { spacing, radius, fonts } from "@/src/theme";
import { apiFetch } from "@/src/api";
import type { Palette } from "@/src/theme/ThemeContext";

type CatalogEntry = { label: string; description: string; roles?: string[] };
type Catalog = Record<string, CatalogEntry>;
type Preferences = Record<string, boolean>;

export type NotificationPreferencesSectionProps = {
  colors: Palette;
};

export default function NotificationPreferencesSection({ colors }: NotificationPreferencesSectionProps) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog>({});
  const [prefs, setPrefs] = useState<Preferences>({});
  const [permStatus, setPermStatus] = useState<"granted" | "denied" | "undetermined" | "web">("undetermined");

  const loadPerms = useCallback(async () => {
    if (Platform.OS === "web") {
      setPermStatus("web");
      return;
    }
    try {
      const { status } = await Notifications.getPermissionsAsync();
      setPermStatus(status as any);
    } catch {
      /* non-fatal */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch("/api/notifications/preferences");
      setCatalog(r.catalog || {});
      setPrefs(r.preferences || {});
    } catch (e: any) {
      Alert.alert("Preferences", e?.message || "Could not load notification preferences");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadPerms();
  }, [load, loadPerms]);

  const setPref = async (key: string, next: boolean) => {
    const prev = prefs;
    // Optimistic update
    const optimistic = { ...prev, [key]: next };
    setPrefs(optimistic);
    setSaving(key);
    try {
      await apiFetch("/api/notifications/preferences", {
        method: "PUT",
        body: JSON.stringify({ preferences: optimistic }),
      });
    } catch (e: any) {
      // Rollback on failure
      setPrefs(prev);
      Alert.alert("Preferences", e?.message || "Could not update preference. Please try again.");
    } finally {
      setSaving(null);
    }
  };

  const requestPerm = async () => {
    try {
      const res = await Notifications.requestPermissionsAsync();
      setPermStatus(res.status as any);
      // If the OS refuses to prompt again, deep-link to Settings.
      if (res.status !== "granted" && res.canAskAgain === false) {
        Linking.openSettings().catch(() => {});
      }
    } catch {
      /* non-fatal */
    }
  };

  const catalogKeys = Object.keys(catalog);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Notifications</Text>
      <Text style={styles.sectionSub}>
        Pick which push notifications land on this device. Delivery only works after your app is published and installed as a native build.
      </Text>

      {/* Permission banner — surfaces when the OS-level permission is
          missing so the toggles below don't appear to "do nothing". */}
      {permStatus === "denied" ? (
        <TouchableOpacity style={styles.permBanner} onPress={requestPerm} testID="push-perm-banner">
          <Ionicons name="notifications-off-outline" size={16} color={colors.warning} />
          <View style={{ flex: 1 }}>
            <Text style={styles.permBannerTitle}>Push access is blocked</Text>
            <Text style={styles.permBannerSub}>Tap to open Settings and re-enable notifications.</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
        </TouchableOpacity>
      ) : permStatus === "undetermined" ? (
        <TouchableOpacity style={styles.permBanner} onPress={requestPerm} testID="push-perm-banner">
          <Ionicons name="notifications-outline" size={16} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.permBannerTitle}>Enable push access</Text>
            <Text style={styles.permBannerSub}>Tap to allow notifications on this device.</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
        </TouchableOpacity>
      ) : permStatus === "web" ? (
        <View style={[styles.permBanner, { borderColor: colors.border }]}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
          <Text style={styles.permBannerSub}>Push notifications only work in the installed native app — not in the web preview.</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={colors.textSecondary} size="small" />
        </View>
      ) : catalogKeys.length === 0 ? (
        <Text style={styles.emptyText}>No notification categories available yet.</Text>
      ) : (
        catalogKeys.map((key, idx) => {
          const entry = catalog[key];
          const enabled = prefs[key] !== false; // default ON
          const busy = saving === key;
          return (
            <View
              key={key}
              style={[styles.row, idx === catalogKeys.length - 1 && { borderBottomWidth: 0 }]}
              testID={`notif-pref-row-${key}`}
            >
              <View style={{ flex: 1, minWidth: 0, marginRight: spacing.md }}>
                <Text style={styles.rowLabel}>{entry.label}</Text>
                <Text style={styles.rowSub}>{entry.description}</Text>
              </View>
              {busy ? (
                <ActivityIndicator color={colors.primary} size="small" />
              ) : (
                <Switch
                  testID={`notif-pref-switch-${key}`}
                  value={enabled}
                  onValueChange={(v) => setPref(key, v)}
                  trackColor={{ false: colors.border, true: colors.primary }}
                  thumbColor="#fff"
                />
              )}
            </View>
          );
        })
      )}
    </View>
  );
}

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
    sectionTitle: {
      color: colors.text,
      fontSize: 16,
      fontWeight: "700" as const,
      fontFamily: fonts.heading,
      marginBottom: 4,
    },
    sectionSub: {
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 18,
      marginBottom: spacing.md,
    },
    permBanner: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: spacing.sm,
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.warning + "55",
      borderRadius: radius.md,
      padding: spacing.sm,
      marginBottom: spacing.md,
    },
    permBannerTitle: {
      color: colors.text,
      fontSize: 13,
      fontWeight: "700" as const,
    },
    permBannerSub: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
    },
    loadingBox: {
      paddingVertical: spacing.lg,
      alignItems: "center" as const,
    },
    emptyText: {
      color: colors.textSecondary,
      fontSize: 13,
      paddingVertical: spacing.md,
    },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    rowLabel: {
      color: colors.text,
      fontSize: 14,
      fontWeight: "600" as const,
      marginBottom: 2,
    },
    rowSub: {
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 16,
    },
  });
}
