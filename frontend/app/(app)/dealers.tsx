import { useCallback, useContext, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  TextInput,
  Switch,
  Platform,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { BottomTabBarHeightContext } from "@react-navigation/bottom-tabs";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";
import DealerPhotosModal from "@/src/components/DealerPhotosModal";
import BrandLogo from "@/src/components/BrandLogo";

type Dealer = {
  id: string;
  email: string;
  active?: boolean;
  archived_at?: string | null;
  agreement_accepted_at?: string | null;
  dealer_info: { first_name: string; last_name: string; phone: string; job_title?: string | null };
  company_info: { company_name: string; company_address: string };
  submission_count: number;
  billable_count?: number;
  billable_total_zar?: number;
  reward_balance?: number;
  reward_lifetime_earned?: number;
  profile_pic?: string | null;
  cover_photo?: string | null;
  created_at: string;
  dealership_id?: string | null;
  dealership?: {
    id: string;
    name: string;
    address?: string;
    active?: boolean;
  } | null;
};

export default function Dealers() {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Safe fallback for when this screen is embedded in the web admin cockpit
  // (which is outside a bottom-tab navigator).
  const tabBarHeight = useContext(BottomTabBarHeightContext) ?? 0;
  const [dealers, setDealers] = useState<Dealer[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<Dealer | null>(null);
  const [photoTarget, setPhotoTarget] = useState<Dealer | null>(null);
  const [savingActiveId, setSavingActiveId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Add-user-to-dealership modal state
  const [invitingDealership, setInvitingDealership] = useState<{ id: string; name: string } | null>(null);
  const [inviteForm, setInviteForm] = useState({ first_name: "", last_name: "", phone: "", job_title: "", email: "", password: "", sa_id_number: "", referred_by_code: "" });
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  // Create-new-dealership modal state (admin-only quick onboarding)
  const [creatingDealership, setCreatingDealership] = useState(false);
  const [newDealershipForm, setNewDealershipForm] = useState({ name: "", address: "", company_reg_no: "", vat_no: "" });
  const [newDealershipSubmitting, setNewDealershipSubmitting] = useState(false);
  const [newDealershipError, setNewDealershipError] = useState<string | null>(null);

  const submitCreateDealership = async () => {
    const name = newDealershipForm.name.trim();
    if (!name) {
      setNewDealershipError("Dealership name is required");
      return;
    }
    setNewDealershipSubmitting(true);
    setNewDealershipError(null);
    try {
      const res = await apiFetch(`/api/admin/dealerships`, {
        method: "POST",
        body: JSON.stringify({
          name,
          address: newDealershipForm.address.trim(),
          company_reg_no: newDealershipForm.company_reg_no.trim() || undefined,
          vat_no: newDealershipForm.vat_no.trim() || undefined,
        }),
      });
      const created = res?.dealership;
      // Close the create modal and immediately open the Add-User modal for the
      // brand-new dealership so the admin can complete the onboarding in one flow.
      setCreatingDealership(false);
      setNewDealershipForm({ name: "", address: "", company_reg_no: "", vat_no: "" });
      // Refresh the dealers list so the empty dealership header appears too.
      await load(showArchived);
      if (created?.id) {
        setInvitingDealership({ id: created.id, name: created.name });
      }
    } catch (e: any) {
      setNewDealershipError(e?.message || "Failed to create dealership");
    } finally {
      setNewDealershipSubmitting(false);
    }
  };

  const submitInvite = async () => {
    if (!invitingDealership) return;
    for (const [k, label] of [["first_name", "First name"], ["last_name", "Last name"], ["email", "Email"], ["password", "Password"], ["sa_id_number", "SA ID Number"]] as const) {
      if (!inviteForm[k].trim()) {
        setInviteError(`${label} is required`);
        return;
      }
    }
    if (inviteForm.password.length < 6) {
      setInviteError("Password must be at least 6 characters");
      return;
    }
    const digits = inviteForm.sa_id_number.replace(/\D+/g, "");
    if (digits.length !== 13) {
      setInviteError("SA ID Number must be 13 digits");
      return;
    }
    setInviteSubmitting(true);
    setInviteError(null);
    try {
      await apiFetch(`/api/admin/dealerships/${invitingDealership.id}/users`, {
        method: "POST",
        body: JSON.stringify({
          email: inviteForm.email.trim().toLowerCase(),
          password: inviteForm.password,
          dealer_info: {
            first_name: inviteForm.first_name.trim(),
            last_name: inviteForm.last_name.trim(),
            phone: inviteForm.phone.trim(),
            job_title: inviteForm.job_title.trim() || undefined,
          },
          sa_id_number: digits,
          referred_by_code: inviteForm.referred_by_code.trim().toUpperCase() || null,
          active: true,
        }),
      });
      setInvitingDealership(null);
      setInviteForm({ first_name: "", last_name: "", phone: "", job_title: "", email: "", password: "", sa_id_number: "", referred_by_code: "" });
      load(showArchived);
    } catch (e: any) {
      setInviteError(e?.message || "Failed to add user");
    } finally {
      setInviteSubmitting(false);
    }
  };

  const load = useCallback(
    async (withArchived: boolean) => {
      try {
        const data = await apiFetch(
          `/api/admin/dealers${withArchived ? "?include_archived=true" : ""}`
        );
        setDealers(data.dealers || []);
      } catch (e) {
        console.log(e);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    []
  );

  useFocusEffect(
    useCallback(() => {
      load(showArchived);
    }, [load, showArchived])
  );

  const showError = (msg: string) => {
    if (Platform.OS === "web" && typeof (globalThis as any).alert === "function") {
      (globalThis as any).alert(msg);
      return;
    }
    Alert.alert("Error", msg);
  };

  // Alert.alert doesn't render on react-native-web, so on web we fall back to
  // window.confirm which produces a native browser dialog. Same signature as
  // Alert.alert with a destructive/OK-style callback.
  const confirmAction = (
    title: string,
    message: string,
    okLabel: string,
    onOk: () => void | Promise<void>
  ) => {
    if (Platform.OS === "web" && typeof (globalThis as any).confirm === "function") {
      const ok = (globalThis as any).confirm(`${title}\n\n${message}`);
      if (ok) onOk();
      return;
    }
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: okLabel, style: "destructive", onPress: () => onOk() },
    ]);
  };

  const removeDealer = (dealer: Dealer) => {
    const n = dealer.submission_count || 0;
    if (n > 0) {
      confirmAction(
        "Archive dealer",
        `${dealer.dealer_info.first_name} ${dealer.dealer_info.last_name} has ${n} submission${n === 1 ? "" : "s"}. They'll be archived so all data and billing history are preserved. They will no longer appear in the active dealers list and won't be able to log in. Proceed?`,
        "Archive",
        async () => {
          setBusyId(dealer.id);
          try {
            await apiFetch(`/api/admin/dealers/${dealer.id}/archive`, { method: "POST" });
            await load(showArchived);
          } catch (e: any) {
            showError(e.message || "Failed to archive");
          } finally {
            setBusyId(null);
          }
        }
      );
      return;
    }
    confirmAction(
      "Remove dealer",
      `Permanently remove ${dealer.dealer_info.first_name} ${dealer.dealer_info.last_name}? This dealer has no submissions so nothing is lost.`,
      "Remove",
      async () => {
        setBusyId(dealer.id);
        try {
          await apiFetch(`/api/admin/dealers/${dealer.id}`, { method: "DELETE" });
          setDealers((prev) => prev.filter((d) => d.id !== dealer.id));
        } catch (e: any) {
          showError(e.message || "Failed to remove");
        } finally {
          setBusyId(null);
        }
      }
    );
  };

  const restoreDealer = (dealer: Dealer) => {
    confirmAction(
      "Restore dealer",
      `Restore ${dealer.dealer_info.first_name} ${dealer.dealer_info.last_name} to the active dealer list?`,
      "Restore",
      async () => {
        setBusyId(dealer.id);
        try {
          await apiFetch(`/api/admin/dealers/${dealer.id}/restore`, { method: "POST" });
          await load(showArchived);
        } catch (e: any) {
          showError(e.message || "Failed to restore");
        } finally {
          setBusyId(null);
        }
      }
    );
  };

  const toggleActive = async (dealer: Dealer, next: boolean) => {
    setSavingActiveId(dealer.id);
    try {
      await apiFetch(`/api/admin/dealers/${dealer.id}/active`, {
        method: "POST",
        body: JSON.stringify({ active: next }),
      });
      setDealers((prev) => prev.map((d) => (d.id === dealer.id ? { ...d, active: next } : d)));
    } catch (e: any) {
      showError(e.message || "Could not update status");
    } finally {
      setSavingActiveId(null);
    }
  };

  const [savingDealershipId, setSavingDealershipId] = useState<string | null>(null);
  // Dealership groups start collapsed — the admin taps a header to reveal
  // the users nested underneath, mirroring the billing screen's UX.
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // ------ Grouping ------
  // Bundle dealers by dealership so the admin sees a single "team" card per
  // dealership with all its users nested. Users without a dealership_id
  // (legacy / mid-migration) get their own "solo" group keyed by user id.
  const groups = useMemo(() => {
    const map = new Map<string, {
      dealership_id: string;
      dealership_name: string;
      dealership_active: boolean;
      dealership_address?: string;
      users: Dealer[];
    }>();
    for (const dealer of dealers) {
      const dsId = dealer.dealership_id || `solo:${dealer.id}`;
      const dsName = dealer.dealership?.name || dealer.company_info?.company_name || "Untitled dealership";
      const dsActive = dealer.dealership?.active ?? (dealer.active !== false);
      const dsAddr = dealer.dealership?.address || dealer.company_info?.company_address;
      const g = map.get(dsId);
      if (g) {
        g.users.push(dealer);
      } else {
        map.set(dsId, {
          dealership_id: dsId,
          dealership_name: dsName,
          dealership_active: dsActive,
          dealership_address: dsAddr,
          users: [dealer],
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.dealership_name.localeCompare(b.dealership_name));
  }, [dealers]);

  const toggleDealershipActive = async (groupId: string, currentActive: boolean) => {
    // Skip synthetic "solo:" IDs — those are for pre-migration users that
    // don't yet have a real dealership document.
    if (groupId.startsWith("solo:")) {
      showError("This dealer is still on the legacy single-user model. Ask them to log in once to auto-migrate, then try again.");
      return;
    }
    const next = !currentActive;
    setSavingDealershipId(groupId);
    try {
      await apiFetch(`/api/admin/dealerships/${groupId}`, {
        method: "PATCH",
        body: JSON.stringify({ active: next }),
      });
      // Reflect the change locally — the backend cascades `active` to every
      // (non-archived) user in the dealership, so mirror that here to avoid a
      // full reload.
      setDealers((prev) => prev.map((d) => (
        d.dealership_id === groupId && !d.archived_at
          ? { ...d, active: next, dealership: d.dealership ? { ...d.dealership, active: next } : d.dealership }
          : d
      )));
    } catch (e: any) {
      showError(e.message || "Could not toggle dealership");
    } finally {
      setSavingDealershipId(null);
    }
  };

  const promptResetPassword = (dealer: Dealer) => {
    // Cross-platform prompt: on web `Alert.prompt` doesn't exist so use window.prompt
    // We'll just call the API with a generated password if no prompt is available.
    const doReset = async (pw: string) => {
      if (!pw || pw.length < 6) {
        showError("Password must be at least 6 characters");
        return;
      }
      setResettingId(dealer.id);
      try {
        await apiFetch(`/api/admin/dealers/${dealer.id}/password`, {
          method: "POST",
          body: JSON.stringify({ new_password: pw }),
        });
        const msg = `New password for ${dealer.email}:\n\n${pw}\n\nShare this securely with the dealer.`;
        if (Platform.OS === "web" && typeof (globalThis as any).alert === "function") {
          (globalThis as any).alert(msg);
        } else {
          Alert.alert("Password reset", msg);
        }
      } catch (e: any) {
        showError(e.message || "Could not reset password");
      } finally {
        setResettingId(null);
      }
    };

    if (Platform.OS === "web" && typeof (globalThis as any).prompt === "function") {
      const pw = (globalThis as any).prompt(
        `Enter a new password for ${dealer.email} (min 6 chars):`,
        ""
      );
      if (pw !== null && pw !== undefined) doReset(pw);
      return;
    }
    if ((Alert as any).prompt) {
      (Alert as any).prompt(
        "Reset password",
        `Enter a new password for ${dealer.email} (min 6 chars).`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Reset", onPress: (v: string) => doReset(v) },
        ],
        "plain-text",
        ""
      );
    } else {
      const auto = "Fourbuy" + Math.floor(1000 + Math.random() * 9000);
      Alert.alert(
        "Confirm password reset",
        `Generate a new password for ${dealer.email}?\n\nSuggested: ${auto}`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Reset", onPress: () => doReset(auto) },
        ]
      );
    }
  };

  const renderItem = ({ item }: { item: Dealer }) => {
    const isArchived = !!item.archived_at;
    const isActive = !isArchived && item.active !== false;
    const statusColor = isArchived
      ? colors.textDisabled
      : isActive
      ? colors.primary
      : colors.danger;
    return (
      <View style={[styles.card, isArchived && styles.cardArchived]} testID={`dealer-card-${item.id}`}>
        <View style={styles.cardTop}>
          <View style={[styles.avatar, { borderColor: statusColor + "55" }]}>
            {item.profile_pic ? (
              <Image source={{ uri: item.profile_pic }} style={styles.avatarImg} />
            ) : (
              <Ionicons name="person" size={22} color={statusColor} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text style={[styles.name, isArchived && { color: colors.textSecondary }]}>
                {item.dealer_info.first_name} {item.dealer_info.last_name}
              </Text>
              {isArchived ? (
                <View style={styles.archivedPill}>
                  <Text style={styles.archivedPillText}>ARCHIVED</Text>
                </View>
              ) : !isActive ? (
                <View style={styles.suspendPill}>
                  <Text style={styles.suspendPillText}>SUSPENDED</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.company}>{item.company_info.company_name}</Text>
            {item.dealer_info.job_title ? (
              <Text style={styles.jobTitleText} testID={`dealer-job-title-${item.id}`}>
                {item.dealer_info.job_title}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.meta}>
          <View style={styles.metaItem}>
            <Ionicons name="mail-outline" size={13} color={colors.textSecondary} />
            <Text style={styles.metaText}>{item.email}</Text>
          </View>
          {item.dealer_info.phone ? (
            <View style={styles.metaItem}>
              <Ionicons name="call-outline" size={13} color={colors.textSecondary} />
              <Text style={styles.metaText}>{item.dealer_info.phone}</Text>
            </View>
          ) : null}
          <View style={styles.metaItem}>
            <Ionicons name="car-outline" size={13} color={colors.textSecondary} />
            <Text style={styles.metaText}>{item.submission_count} submissions</Text>
          </View>
          {(item.billable_count || 0) > 0 ? (
            <View style={styles.metaItem}>
              <Ionicons name="cash-outline" size={13} color={colors.neon} />
              <Text style={[styles.metaText, { color: colors.neon }]}>
                {item.billable_count} billable · R{item.billable_total_zar?.toFixed(2)}
              </Text>
            </View>
          ) : null}
          {(item.reward_balance || 0) > 0 || (item.reward_lifetime_earned || 0) > 0 ? (
            <View style={styles.metaItem}>
              <Ionicons name="ribbon-outline" size={13} color={colors.textSecondary} />
              <Text style={styles.metaText}>
                <Text style={{ color: colors.text, fontWeight: "700" }}>
                  {item.reward_balance || 0} pts
                </Text>
                {(item.reward_lifetime_earned || 0) > 0
                  ? ` · ${item.reward_lifetime_earned} lifetime`
                  : ""}
              </Text>
            </View>
          ) : null}
          {isArchived && item.archived_at ? (
            <View style={styles.metaItem}>
              <Ionicons name="archive-outline" size={13} color={colors.textSecondary} />
              <Text style={styles.metaText}>
                Archived {new Date(item.archived_at).toLocaleDateString()}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={styles.actionsRow}>
          {isArchived ? (
            <TouchableOpacity
              testID={`dealer-restore-${item.id}`}
              style={[styles.actionBtn, styles.restoreBtn]}
              onPress={() => restoreDealer(item)}
              disabled={busyId === item.id}
            >
              {busyId === item.id ? (
                <ActivityIndicator size="small" color={colors.neon} />
              ) : (
                <>
                  <Ionicons name="refresh" size={16} color={colors.neon} />
                  <Text style={[styles.actionBtnText, { color: colors.neon }]}>Restore</Text>
                </>
              )}
            </TouchableOpacity>
          ) : (
            <>
              <View style={styles.activeCol}>
                <Text style={styles.activeLabel}>{isActive ? "ACTIVE" : "SUSPENDED"}</Text>
                {savingActiveId === item.id ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Switch
                    testID={`dealer-active-toggle-${item.id}`}
                    value={isActive}
                    onValueChange={(v) => toggleActive(item, v)}
                    trackColor={{ false: colors.border, true: colors.neon }}
                    thumbColor={isActive ? "#000" : colors.textSecondary}
                  />
                )}
              </View>
              <View style={{ flex: 1 }} />
              <TouchableOpacity
                testID={`dealer-edit-${item.id}`}
                style={styles.actionBtn}
                onPress={() => setEditing(item)}
              >
                <Ionicons name="create-outline" size={16} color={colors.text} />
                <Text style={styles.actionBtnText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID={`dealer-photos-${item.id}`}
                style={styles.actionBtn}
                onPress={() => setPhotoTarget(item)}
              >
                <Ionicons
                  name={item.profile_pic || item.cover_photo ? "images" : "images-outline"}
                  size={16}
                  color={colors.text}
                />
                <Text style={styles.actionBtnText}>Photos</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID={`dealer-reset-pw-${item.id}`}
                style={styles.actionBtn}
                onPress={() => promptResetPassword(item)}
                disabled={resettingId === item.id}
              >
                {resettingId === item.id ? (
                  <ActivityIndicator size="small" color={colors.text} />
                ) : (
                  <>
                    <Ionicons name="key-outline" size={16} color={colors.text} />
                    <Text style={styles.actionBtnText}>Reset PW</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                testID={`dealer-add-teammate-${item.id}`}
                style={styles.actionBtn}
                onPress={() => setInvitingDealership({ id: item.dealership_id ?? item.id, name: item.company_info.company_name })}
              >
                <Ionicons name="person-add-outline" size={16} color={colors.text} />
                <Text style={styles.actionBtnText}>Add User</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID={`remove-dealer-${item.id}`}
                style={[styles.actionBtn, styles.dangerBtn]}
                onPress={() => removeDealer(item)}
                disabled={busyId === item.id}
              >
                {busyId === item.id ? (
                  <ActivityIndicator size="small" color={colors.danger} />
                ) : (
                  <Ionicons
                    name={item.submission_count > 0 ? "archive-outline" : "trash-outline"}
                    size={16}
                    color={colors.danger}
                  />
                )}
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  };

  const activeCount = dealers.filter((d) => !d.archived_at && d.active !== false).length;
  const suspendedCount = dealers.filter((d) => !d.archived_at && d.active === false).length;
  const archivedCount = dealers.filter((d) => !!d.archived_at).length;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Manage Dealers</Text>
            <Text style={styles.headerSub}>
              {dealers.length - archivedCount} registered · {activeCount} active
              {suspendedCount > 0 ? ` · ${suspendedCount} suspended` : ""}
              {showArchived && archivedCount > 0 ? ` · ${archivedCount} archived` : ""}
            </Text>
          </View>
          <BrandLogo size="sm" />
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            testID="dealers-new-dealership-btn"
            onPress={() => {
              setNewDealershipError(null);
              setNewDealershipForm({ name: "", address: "", company_reg_no: "", vat_no: "" });
              setCreatingDealership(true);
            }}
            style={[styles.archTgl, styles.newDealershipBtn]}
          >
            <Ionicons name="add-circle" size={14} color="#000" />
            <Text style={[styles.archTglText, styles.archTglTextActive]}>New Dealership</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="dealers-toggle-archived"
            onPress={() => {
              setLoading(true);
              setShowArchived((v) => !v);
            }}
            style={[styles.archTgl, showArchived && styles.archTglActive]}
          >
            <Ionicons
              name={showArchived ? "eye" : "eye-off"}
              size={14}
              color={showArchived ? "#000" : colors.textSecondary}
            />
            <Text style={[styles.archTglText, showArchived && styles.archTglTextActive]}>
              {showArchived ? "Showing archived" : "Show archived"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : dealers.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="people-outline" size={64} color={colors.textDisabled} />
          <Text style={styles.emptyTitle}>
            {showArchived ? "No archived dealers" : "No dealers yet"}
          </Text>
          <Text style={styles.emptyText}>
            {showArchived
              ? "Nothing archived. All your dealers are active."
              : "Dealers will appear here once they register"}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={groups.map((g) => ({
            key: g.dealership_id,
            title: g.dealership_name,
            // Only expose users when the group is expanded — the header
            // itself is always rendered.
            data: expandedGroups[g.dealership_id] ? g.users : [],
            group: g,
          }))}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => {
            const g = (section as any).group as (typeof groups)[number];
            const isSolo = g.dealership_id.startsWith("solo:");
            const activeUsers = g.users.filter((u) => !u.archived_at).length;
            const disabled = isSolo || savingDealershipId === g.dealership_id;
            const isExpanded = !!expandedGroups[g.dealership_id];
            return (
              <View style={styles.groupHeader} testID={`group-${g.dealership_id}`}>
                {/* LEFT: chevron + title — this is the toggle target. Only
                    this region flips the expanded state so the ACTIVE/DISABLED
                    switch and Add-User button don't inadvertently expand the
                    group (react-native-web doesn't stop propagation from a
                    child Switch, unlike native). */}
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => setExpandedGroups((e) => ({ ...e, [g.dealership_id]: !e[g.dealership_id] }))}
                  style={styles.groupHeaderToggle}
                  testID={`group-toggle-open-${g.dealership_id}`}
                >
                  <Ionicons
                    name={isExpanded ? "chevron-down" : "chevron-forward"}
                    size={18}
                    color={colors.textSecondary}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.groupName}>{g.dealership_name}</Text>
                    <Text style={styles.groupSub}>
                      {g.users.length} user{g.users.length === 1 ? "" : "s"}
                      {activeUsers !== g.users.length ? ` · ${activeUsers} active` : ""}
                      {isSolo ? " · legacy" : ""}
                    </Text>
                  </View>
                </TouchableOpacity>
                <View style={styles.groupToggleWrap}>
                  {!isSolo ? (
                    <TouchableOpacity
                      testID={`group-add-user-${g.dealership_id}`}
                      onPress={() => setInvitingDealership({ id: g.dealership_id, name: g.dealership_name })}
                      style={styles.groupAddBtn}
                    >
                      <Ionicons name="person-add-outline" size={16} color={colors.text} />
                    </TouchableOpacity>
                  ) : null}
                  <Text style={[styles.groupToggleLabel, !g.dealership_active && styles.groupToggleLabelOff]}>
                    {g.dealership_active ? "ACTIVE" : "DISABLED"}
                  </Text>
                  <Switch
                    testID={`group-toggle-${g.dealership_id}`}
                    value={g.dealership_active}
                    onValueChange={() => toggleDealershipActive(g.dealership_id, g.dealership_active)}
                    disabled={disabled}
                    trackColor={{ true: colors.primary, false: colors.border }}
                    thumbColor="#fff"
                  />
                </View>
              </View>
            );
          }}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={[styles.list, { paddingBottom: tabBarHeight + spacing.md }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load(showArchived);
              }}
              tintColor={colors.primary}
            />
          }
        />
      )}

      <EditDealerModal
        dealer={editing}
        onClose={() => setEditing(null)}
        onSaved={(fresh) => {
          setDealers((prev) => prev.map((d) => (d.id === fresh.id ? { ...d, ...fresh } : d)));
          setEditing(null);
        }}
      />

      {/* Add-user-to-existing-dealership modal (admin only). All users of a
          dealership are equal — they share submissions & billing. */}
      <Modal visible={!!invitingDealership} animationType="slide" transparent onRequestClose={() => setInvitingDealership(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add User to {invitingDealership?.name}</Text>
              <TouchableOpacity onPress={() => setInvitingDealership(null)}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalHint}>
              This user will share this dealership&apos;s submissions and monthly billing.
            </Text>
            {[
              ["First Name", "first_name"],
              ["Last Name", "last_name"],
              ["Phone", "phone"],
              ["Job Title (optional)", "job_title"],
              ["SA ID Number", "sa_id_number"],
              ["Email", "email"],
              ["Password (min 6 chars)", "password"],
              ["Referred By (optional code)", "referred_by_code"],
            ].map(([label, key]) => (
              <View key={key} style={styles.modalField}>
                <Text style={styles.modalLabel}>{label}</Text>
                <TextInput
                  style={styles.modalInput}
                  value={(inviteForm as any)[key]}
                  onChangeText={(v) => setInviteForm((f) => ({ ...f, [key]: v }))}
                  autoCapitalize={key === "email" || key === "referred_by_code" ? "characters" : key === "sa_id_number" ? "none" : "words"}
                  keyboardType={key === "email" ? "email-address" : key === "phone" ? "phone-pad" : key === "sa_id_number" ? "number-pad" : "default"}
                  secureTextEntry={key === "password"}
                  maxLength={key === "sa_id_number" ? 13 : key === "referred_by_code" ? 6 : undefined}
                  placeholder={key === "referred_by_code" ? "e.g. A7X9K2" : key === "sa_id_number" ? "13 digits" : label}
                  placeholderTextColor={colors.textDisabled}
                  testID={`invite-${key}`}
                />
              </View>
            ))}
            {inviteError ? <Text style={styles.modalError}>{inviteError}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => {
                  setInvitingDealership(null);
                  setInviteError(null);
                }}
                disabled={inviteSubmitting}
              >
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="invite-submit"
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={submitInvite}
                disabled={inviteSubmitting}
              >
                {inviteSubmitting ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.modalBtnPrimaryText}>Add User</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Create-new-dealership modal — admin-only quick onboarding. On success
          we immediately open the Add-User modal for the freshly-created
          dealership so the whole "new dealership + first user" flow feels
          like a single step. */}
      <Modal
        visible={creatingDealership}
        animationType="slide"
        transparent
        onRequestClose={() => setCreatingDealership(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New Dealership</Text>
              <TouchableOpacity onPress={() => setCreatingDealership(false)} testID="new-dealership-close">
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalHint}>
              Create a new dealership record. You&apos;ll be prompted to add its first
              user immediately after.
            </Text>
            {[
              ["Dealership Name", "name", "e.g. Hatfield Ford Bryanston"],
              ["Address (optional)", "address", "e.g. 123 Main Rd, Bryanston"],
              ["Company Reg No (optional)", "company_reg_no", "e.g. 2020/123456/07"],
              ["VAT No (optional)", "vat_no", "e.g. 4520123456"],
            ].map(([label, key, placeholder]) => (
              <View key={key} style={styles.modalField}>
                <Text style={styles.modalLabel}>{label}</Text>
                <TextInput
                  style={styles.modalInput}
                  value={(newDealershipForm as any)[key]}
                  onChangeText={(v) => setNewDealershipForm((f) => ({ ...f, [key]: v }))}
                  autoCapitalize={key === "name" || key === "address" ? "words" : "characters"}
                  placeholder={placeholder}
                  placeholderTextColor={colors.textDisabled}
                  testID={`new-dealership-${key}`}
                />
              </View>
            ))}
            {newDealershipError ? <Text style={styles.modalError}>{newDealershipError}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setCreatingDealership(false)}
                disabled={newDealershipSubmitting}
              >
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="new-dealership-submit"
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={submitCreateDealership}
                disabled={newDealershipSubmitting}
              >
                {newDealershipSubmitting ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.modalBtnPrimaryText}>Create &amp; Add User</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <DealerPhotosModal
        dealer={
          photoTarget
            ? {
                id: photoTarget.id,
                name: `${photoTarget.dealer_info.first_name} ${photoTarget.dealer_info.last_name}`,
                profile_pic: photoTarget.profile_pic,
                cover_photo: photoTarget.cover_photo,
              }
            : null
        }
        onClose={() => setPhotoTarget(null)}
        onSaved={(fresh) => {
          setDealers((prev) =>
            prev.map((d) =>
              d.id === fresh.id
                ? { ...d, profile_pic: fresh.profile_pic, cover_photo: fresh.cover_photo }
                : d
            )
          );
          setPhotoTarget(null);
        }}
      />
    </SafeAreaView>
  );
}

// -----------------------------------------------------------------------------
// Edit dealer modal
// -----------------------------------------------------------------------------
function EditDealerModal({
  dealer,
  onClose,
  onSaved,
}: {
  dealer: Dealer | null;
  onClose: () => void;
  onSaved: (fresh: Dealer) => void;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [email, setEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyAddress, setCompanyAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset fields whenever a new dealer is opened.
  useFocusEffect(
    useCallback(() => {
      if (!dealer) return;
      setFirstName(dealer.dealer_info.first_name || "");
      setLastName(dealer.dealer_info.last_name || "");
      setPhone(dealer.dealer_info.phone || "");
      setJobTitle(dealer.dealer_info.job_title || "");
      setEmail(dealer.email || "");
      setCompanyName(dealer.company_info.company_name || "");
      setCompanyAddress(dealer.company_info.company_address || "");
      setError(null);
    }, [dealer])
  );

  const save = async () => {
    if (!dealer) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/dealers/${dealer.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          phone: phone.trim(),
          job_title: jobTitle.trim(),
          email: email.trim().toLowerCase(),
          company_name: companyName.trim(),
          company_address: companyAddress.trim(),
        }),
      });
      onSaved(res.dealer);
    } catch (e: any) {
      setError(e.message || "Could not save changes");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={!!dealer} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Edit Dealer</Text>
            <TouchableOpacity onPress={onClose} testID="edit-dealer-close">
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}>
            <Field label="First name" value={firstName} onChangeText={setFirstName} testID="edit-first-name" />
            <Field label="Last name" value={lastName} onChangeText={setLastName} testID="edit-last-name" />
            <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" testID="edit-phone" />
            <Field label="Job title" value={jobTitle} onChangeText={setJobTitle} testID="edit-job-title" placeholder="e.g. Sales Manager" />
            <Field label="Email (login username)" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" testID="edit-email" />
            <Field label="Company name" value={companyName} onChangeText={setCompanyName} testID="edit-company-name" />
            <Field label="Company address" value={companyAddress} onChangeText={setCompanyAddress} testID="edit-company-address" multiline />
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>

          <View style={styles.modalFooter}>
            <TouchableOpacity onPress={onClose} style={styles.modalCancelBtn}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="edit-dealer-save"
              style={[styles.modalSaveBtn, saving && { opacity: 0.6 }]}
              onPress={save}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <>
                  <Ionicons name="checkmark" size={16} color={colors.onPrimary} />
                  <Text style={styles.modalSaveText}>Save</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Field({
  label,
  ...rest
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboardType?: any;
  autoCapitalize?: any;
  multiline?: boolean;
  testID?: string;
  placeholder?: string;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View>
      <Text style={styles.fieldLabel}>{label.toUpperCase()}</Text>
      <TextInput
        style={[styles.input, rest.multiline && { minHeight: 80, textAlignVertical: "top" }]}
        placeholderTextColor={colors.textDisabled}
        {...rest}
      />
    </View>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: { color: colors.text, fontSize: 22, fontWeight: "800", fontFamily: fonts.heading, letterSpacing: 0.3 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  headerSub: { color: colors.textSecondary, fontSize: 13, marginTop: 4, letterSpacing: 0.1 },
  headerActions: { flexDirection: "row", marginTop: spacing.sm, gap: spacing.sm, flexWrap: "wrap" },
  archTgl: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  archTglActive: { backgroundColor: colors.neon, borderColor: colors.neon },
  archTglText: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  archTglTextActive: { color: colors.onPrimary },
  newDealershipBtn: { backgroundColor: colors.neon, borderColor: colors.neon },
  list: { padding: spacing.md, paddingBottom: spacing.xl },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardArchived: { opacity: 0.72, borderStyle: "dashed" },
  cardTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.paper,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  avatarImg: { width: "100%", height: "100%" },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { color: colors.text, fontSize: 16, fontWeight: "700" },
  suspendPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.danger + "22",
    borderWidth: 1,
    borderColor: colors.danger + "55",
  },
  suspendPillText: { color: colors.danger, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  archivedPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.textDisabled + "22",
    borderWidth: 1,
    borderColor: colors.textDisabled + "55",
  },
  archivedPillText: { color: colors.textSecondary, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  restoreBtn: { borderColor: colors.neon + "55", backgroundColor: colors.neon + "12" },
  company: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  meta: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 4,
  },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: { color: colors.textSecondary, fontSize: 12 },
  actionsRow: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  activeCol: { flexDirection: "row", alignItems: "center", gap: 6 },
  activeLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: "800", letterSpacing: 1.5 },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  actionBtnText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  dangerBtn: { borderColor: colors.danger + "55", backgroundColor: colors.danger + "10" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.lg },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "700", marginTop: spacing.sm },
  emptyText: { color: colors.textSecondary, fontSize: 14, textAlign: "center" },

  // Edit modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.neon + "55",
    maxHeight: "90%",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  fieldLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginBottom: 6 },
  input: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  error: { color: colors.danger, fontSize: 13 },
  modalFooter: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.paper,
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    backgroundColor: colors.card,
  },
  modalCancelText: { color: colors.textSecondary, fontWeight: "700" },
  modalSaveBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  modalSaveText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 1 },

  // Add-team-member modal
  modalHint: { color: colors.textSecondary, fontSize: 12, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  modalField: { paddingHorizontal: spacing.md, paddingVertical: 6 },
  modalLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginBottom: 6 },
  modalInput: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  modalError: { color: colors.danger, fontSize: 13, paddingHorizontal: spacing.md, paddingTop: 6 },
  modalActions: { flexDirection: "row", gap: spacing.sm, padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.paper },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  modalBtnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  modalBtnGhostText: { color: colors.textSecondary, fontWeight: "700" },
  modalBtnPrimary: { backgroundColor: colors.primary },
  modalBtnPrimaryText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 1 },

  // Dealer row extras
  jobTitleText: { color: colors.textSecondary, fontSize: 12, marginTop: 2, fontStyle: "italic", letterSpacing: 0.2 },

  // Grouped dealership header
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  groupHeaderToggle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    // Give the tap area enough padding for a comfortable target on mobile.
    paddingVertical: 4,
  },
  groupName: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 0.4 },
  groupSub: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  groupToggleWrap: { flexDirection: "row", alignItems: "center", gap: 8 },
  groupAddBtn: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
    alignItems: "center",
    justifyContent: "center",
  },
  groupToggleLabel: { color: colors.primary, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  groupToggleLabelOff: { color: colors.textSecondary },
});
