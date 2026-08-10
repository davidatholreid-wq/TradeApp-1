import { useEffect, useState, useMemo } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, Modal, Image, ActivityIndicator, ScrollView, Platform, Alert, useWindowDimensions } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";
import { apiFetch } from "@/src/api";

export type DealerPhotoTarget = {
  id: string;
  name: string;
  profile_pic?: string | null;
  cover_photo?: string | null;
};

type Props = {
  dealer: DealerPhotoTarget | null;
  onClose: () => void;
  onSaved: (fresh: { id: string; profile_pic?: string | null; cover_photo?: string | null }) => void;
};

// Admin-only modal to upload/replace a dealer's WhatsApp Business-style
// profile picture and cover photo. Photos are base64-encoded and posted to
// POST /api/admin/dealers/{id}/photos. Empty string clears a photo.
export default function DealerPhotosModal({ dealer, onClose, onSaved }: Props) {
  const colors = useThemeColors();
  const { width: winW } = useWindowDimensions();
  // Wide-viewport = "centered card" layout (desktop web / tablet).
  // Narrow = full-height bottom-sheet (phone).
  const isWide = winW >= 720;
  const styles = useMemo(() => makeStyles(colors, isWide), [colors, isWide]);
  const [profilePic, setProfilePic] = useState<string | null | undefined>(undefined);
  const [coverPhoto, setCoverPhoto] = useState<string | null | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync local state whenever a new dealer is opened.
  useEffect(() => {
    if (!dealer) return;
    setProfilePic(dealer.profile_pic ?? null);
    setCoverPhoto(dealer.cover_photo ?? null);
    setDirty(false);
    setError(null);
  }, [dealer]);

  const pick = async (kind: "profile" | "cover") => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setError("Photo library access is required to select an image.");
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.8,
        allowsEditing: true,
        aspect: kind === "profile" ? [1, 1] : [16, 9],
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      const b64 = asset.base64;
      if (!b64) {
        setError("Could not read the selected image. Please try another file.");
        return;
      }

      // === 1. Aspect-ratio guard =============================================
      // On native platforms the image-picker crops to `aspect` before
      // returning, so the returned dimensions always match. On web
      // `allowsEditing` is a no-op — the raw file comes through — so we
      // measure width / height ourselves and reject anything more than
      // 5% off the target ratio.
      const w = asset.width || 0;
      const h = asset.height || 0;
      if (w > 0 && h > 0) {
        const ratio = w / h;
        const target = kind === "cover" ? 16 / 9 : 1;
        const drift = Math.abs(ratio - target) / target;
        if (drift > 0.05) {
          const nice = kind === "cover" ? "16:9 (e.g. 1600 × 900)" : "1:1 (e.g. 512 × 512)";
          const msg = `Aspect ratio ${ratio.toFixed(2)}:1 doesn't match the required ${nice}. Please crop the ${kind} photo before uploading.`;
          setError(msg);
          if (Platform.OS !== "web") Alert.alert("Aspect ratio", msg);
          return;
        }
      }

      // === 2. File-size guard ================================================
      // Business rule: both profile + cover capped at 500 KB (raw
      // bytes). Base64 encoding adds ~37% overhead, so the b64 string
      // ceiling = 500 KB × 1.37 ≈ 685 KB.
      const rawKb = Math.round((b64.length * 3) / 4 / 1024);
      const maxKb = 500;
      if (rawKb > maxKb) {
        const msg = `That ${kind} photo is ${rawKb} KB — max allowed is ${maxKb} KB. Please re-export at a smaller size or lower JPEG quality.`;
        setError(msg);
        if (Platform.OS !== "web") Alert.alert("Photo too large", msg);
        return;
      }

      const data = `data:image/jpeg;base64,${b64}`;
      if (kind === "profile") setProfilePic(data);
      else setCoverPhoto(data);
      setDirty(true);
      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not attach photo");
    }
  };

  const clear = (kind: "profile" | "cover") => {
    if (kind === "profile") setProfilePic("");
    else setCoverPhoto("");
    setDirty(true);
  };

  const save = async () => {
    if (!dealer) return;
    setSaving(true);
    setError(null);
    try {
      const body: any = {};
      // Only send fields the admin actually changed.
      if (profilePic !== undefined && profilePic !== (dealer.profile_pic ?? null)) {
        body.profile_pic = profilePic ?? "";
      }
      if (coverPhoto !== undefined && coverPhoto !== (dealer.cover_photo ?? null)) {
        body.cover_photo = coverPhoto ?? "";
      }
      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }
      const res = await apiFetch(`/api/admin/dealers/${dealer.id}/photos`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      onSaved({
        id: dealer.id,
        profile_pic: res.dealer?.profile_pic ?? null,
        cover_photo: res.dealer?.cover_photo ?? null,
      });
    } catch (e: any) {
      const msg = e.message || "Could not save photos";
      setError(msg);
      if (Platform.OS !== "web") Alert.alert("Error", msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={!!dealer} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>DEALER PHOTOS</Text>
              <Text style={styles.subtitle} numberOfLines={1}>{dealer?.name ?? ""}</Text>
            </View>
            <TouchableOpacity onPress={onClose} testID="dealer-photos-close">
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            {/* Cover preview */}
            <View style={styles.coverPreview}>
              {coverPhoto ? (
                <Image source={{ uri: coverPhoto }} style={styles.coverImg} resizeMode="cover" />
              ) : (
                <View style={styles.coverPlaceholder}>
                  <Ionicons name="image-outline" size={28} color={colors.textDisabled} />
                  <Text style={styles.placeholderText}>NO COVER PHOTO</Text>
                </View>
              )}
              {/* Profile pic overlaid, WhatsApp Business style */}
              <View style={styles.profileWrap}>
                {profilePic ? (
                  <Image source={{ uri: profilePic }} style={styles.profileImg} />
                ) : (
                  <View style={styles.profilePlaceholder}>
                    <Ionicons name="person" size={28} color={colors.textDisabled} />
                  </View>
                )}
              </View>
            </View>

            <View style={{ height: spacing.xl }} />

            {/* Cover controls */}
            <Text style={styles.groupLabel}>COVER PHOTO</Text>
            <Text style={styles.groupHint}>
              Wide banner (16:9). Recommended: <Text style={styles.groupHintBold}>1600 × 900 px</Text> · max <Text style={styles.groupHintBold}>500 KB</Text>. Shown at the top of the dealer profile, on submitted vehicles, and in the admin cockpit.
            </Text>
            <View style={styles.btnRow}>
              <TouchableOpacity style={styles.btn} onPress={() => pick("cover")} testID="dealer-cover-upload">
                <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
                <Text style={styles.btnText}>{coverPhoto ? "Replace" : "Upload"}</Text>
              </TouchableOpacity>
              {coverPhoto ? (
                <TouchableOpacity style={[styles.btn, styles.btnDanger]} onPress={() => clear("cover")} testID="dealer-cover-clear">
                  <Ionicons name="trash-outline" size={16} color={colors.danger} />
                  <Text style={[styles.btnText, { color: colors.danger }]}>Remove</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {/* Profile controls */}
            <Text style={[styles.groupLabel, { marginTop: spacing.lg }]}>PROFILE PICTURE</Text>
            <Text style={styles.groupHint}>
              Square avatar (1:1). Recommended: <Text style={styles.groupHintBold}>512 × 512 px</Text> · max <Text style={styles.groupHintBold}>500 KB</Text>. Shown as the round photo above the cover.
            </Text>
            <View style={styles.btnRow}>
              <TouchableOpacity style={styles.btn} onPress={() => pick("profile")} testID="dealer-profile-upload">
                <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
                <Text style={styles.btnText}>{profilePic ? "Replace" : "Upload"}</Text>
              </TouchableOpacity>
              {profilePic ? (
                <TouchableOpacity style={[styles.btn, styles.btnDanger]} onPress={() => clear("profile")} testID="dealer-profile-clear">
                  <Ionicons name="trash-outline" size={16} color={colors.danger} />
                  <Text style={[styles.btnText, { color: colors.danger }]}>Remove</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="dealer-photos-save"
              style={[styles.saveBtn, (!dirty || saving) && { opacity: 0.5 }]}
              onPress={save}
              disabled={!dirty || saving}
            >
              {saving ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <>
                  <Ionicons name="checkmark" size={16} color={colors.onPrimary} />
                  <Text style={styles.saveText}>Save Photos</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Palette, isWide: boolean) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    // Centered card on desktop / tablet; bottom sheet on phone.
    justifyContent: isWide ? "center" : "flex-end",
    alignItems: isWide ? "center" : "stretch",
    padding: isWide ? spacing.lg : 0,
  },
  card: {
    backgroundColor: colors.card,
    // Rounded on all corners for centered card; top-only for bottom sheet.
    borderRadius: isWide ? radius.lg : 0,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    maxHeight: isWide ? 640 : "92%",
    width: isWide ? "100%" : undefined,
    maxWidth: isWide ? 560 : undefined,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: "800", letterSpacing: 2, fontFamily: fonts.heading },
  subtitle: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  body: { padding: spacing.md },
  coverPreview: {
    // Use 16:9 aspect ratio so the admin sees the EXACT crop that
    // will render on the dealer profile + vehicle detail banner
    // across every platform. Height is implicitly bounded by the
    // modal card's `maxWidth: 560` on desktop, so this can't dominate
    // the viewport any more.
    width: "100%",
    aspectRatio: 16 / 9,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    position: "relative",
  },
  coverImg: { width: "100%", height: "100%" },
  coverPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  placeholderText: { color: colors.textDisabled, fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  profileWrap: {
    position: "absolute",
    bottom: -32,
    left: 16,
    borderRadius: 40,
    padding: 4,
    backgroundColor: colors.card,
  },
  profileImg: { width: 72, height: 72, borderRadius: 36 },
  profilePlaceholder: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  groupLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: "800", letterSpacing: 2 },
  groupHint: { color: colors.textDisabled, fontSize: 12, marginTop: 4, marginBottom: spacing.sm, lineHeight: 16 },
  groupHintBold: { color: colors.textSecondary, fontWeight: "800" },
  btnRow: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.paper,
  },
  btnDanger: { borderColor: colors.danger + "55", backgroundColor: colors.danger + "11" },
  btnText: { color: colors.text, fontWeight: "800", fontSize: 12, letterSpacing: 1 },
  error: { color: colors.danger, fontSize: 13, marginTop: spacing.md },
  footer: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.paper,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    backgroundColor: colors.card,
  },
  cancelText: { color: colors.textSecondary, fontWeight: "700" },
  saveBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  saveText: { color: colors.onPrimary, fontWeight: "800", letterSpacing: 1 },
});
