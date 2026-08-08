import { useState, useEffect, useRef } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { colors, spacing, radius } from "@/src/theme";
import { storage } from "@/src/utils/storage";
import { decodeLicenseDisk, summariseLicenseDisk } from "@/src/utils/licenseDisk";
import { apiFetch } from "@/src/api";

export const SCAN_BUFFER_KEY = "app.scan.buffer";
export const SCAN_PARSED_KEY = "app.scan.parsed";
// Base64 image (data-URL) of the licence disc so the submit screen can
// upload it alongside the decoded data — one persisted photo, whether
// the user scanned via the camera or picked from their library.
export const SCAN_PHOTO_KEY = "app.scan.photo";

// Ignore any barcode detection fired within this window after mount —
// avoids the CameraView firing an immediate "phantom" scan on re-entry
// when a barcode is still cached in its native buffer from a previous
// visit. Long enough to swallow the buffer, short enough to feel snappy.
const MOUNT_SETTLE_MS = 900;

/**
 * Scan / upload the SA license disc PDF-417 barcode.
 *
 * Two entry paths — both write to the same AsyncStorage keys so the
 * submit screen behaves identically on return:
 *   1. Live camera scan — expo-camera decodes PDF-417 on-device; we
 *      snap a still frame and persist it alongside the decoded data.
 *   2. Upload from gallery — dealer picks a photo; the backend runs
 *      zxing-cpp on the image and returns the decoded raw + parsed
 *      structured fields.
 */
export default function ScanScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ returnPath?: string; submissionId?: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const cameraRef = useRef<any>(null);
  const mountedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    // On every fresh mount, wipe any stale scan artefacts from a previous
    // session so this scan starts from a clean slate. This is what the
    // user hits after a "Reset" on the submit form: without the wipe,
    // the old barcode/parsed/photo would still be sitting in storage
    // and could confuse downstream screens.
    (async () => {
      await storage.removeItem(SCAN_BUFFER_KEY);
      await storage.removeItem(SCAN_PARSED_KEY);
      await storage.removeItem(SCAN_PHOTO_KEY);
    })();
    mountedAtRef.current = Date.now();
    setScanned(null);
  }, []);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  const returnToCaller = () => {
    // `attachDisk` — the caller opened the scanner from a vehicle detail
    // to non-billably attach a licence disc to an existing sub. We route
    // back with `?attach=1` so the vehicle screen knows to consume the
    // stashed scan payload and PATCH /license-disk.
    if (params?.returnPath === "attachDisk" && params?.submissionId) {
      router.replace({
        pathname: "/(app)/vehicle/[id]",
        params: { id: String(params.submissionId), attach: "1" },
      } as any);
      return;
    }
    const target = params?.returnPath === "submit" ? "/(app)/submit" : null;
    if (target) {
      router.replace(target as any);
    } else {
      router.back();
    }
  };

  const persistAndReturn = async (
    raw: string,
    imageDataUrl?: string | null,
    parsedOverride?: any,
  ) => {
    await storage.setItem(SCAN_BUFFER_KEY, raw);
    // Prefer a parsed object supplied by the caller (used when the backend
    // OCR-decoded the disc and gave us structured fields directly). Falls
    // back to the client-side PDF-417 string parser for the live-camera
    // scan path.
    try {
      const parsed = parsedOverride && Object.keys(parsedOverride).length
        ? parsedOverride
        : decodeLicenseDisk(raw);
      await storage.setItem(SCAN_PARSED_KEY, JSON.stringify(parsed));
      console.log("License disk parsed:", summariseLicenseDisk(parsed));
    } catch (e) {
      console.log("decodeLicenseDisk failed", e);
    }
    if (imageDataUrl) {
      await storage.setItem(SCAN_PHOTO_KEY, imageDataUrl);
    }
    setTimeout(returnToCaller, 500);
  };

  // ------- Live camera scan handler -------
  const handleScanned = async ({ data }: { data: string }) => {
    // Guard 1: swallow anything the CameraView fires from a stale native
    // buffer immediately after mount — this is the "phantom scan" that
    // used to strand the user on "Scanned! Returning…" when they came
    // back to this screen after a Reset.
    if (Date.now() - mountedAtRef.current < MOUNT_SETTLE_MS) return;
    // Guard 2: only accept the first genuine scan per screen visit.
    if (scanned) return;
    if (!data || !String(data).trim()) return;
    setScanned(data);
    // Best-effort still capture from the live camera view. On web (Expo
    // Go browser preview) `takePictureAsync` isn't supported — we just
    // skip the photo capture there and rely on the decoded data.
    let photoDataUrl: string | null = null;
    try {
      const camera = cameraRef.current;
      if (camera?.takePictureAsync) {
        const shot = await camera.takePictureAsync({ base64: true, quality: 0.7, skipProcessing: true });
        if (shot?.base64) {
          photoDataUrl = `data:image/jpeg;base64,${shot.base64}`;
        }
      }
    } catch (err) {
      console.log("scan still-capture failed", err);
    }
    await persistAndReturn(data, photoDataUrl);
  };

  // Manual reset — used by the "Retake" button when the user wants to
  // rescan (either after a mis-fire or simply to try a different frame).
  const retake = () => {
    setScanned(null);
    mountedAtRef.current = Date.now(); // re-open the settle window
  };

  // ------- Upload photo (server-side decode) handler -------
  const handleUploadPhoto = async () => {
    if (uploading) return;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Photo access needed",
          "Please allow access to your photo library to upload a photo of the license disc.",
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.8,
        allowsEditing: false,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const b64 = asset.base64 ? `data:image/jpeg;base64,${asset.base64}` : null;
      if (!b64) {
        Alert.alert("Upload failed", "Could not read the selected photo.");
        return;
      }
      setUploading(true);
      // `apiFetch` returns the parsed JSON directly (or throws on non-2xx).
      let json: any;
      try {
        json = await apiFetch("/api/vehicles/license-disk/decode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_base64: b64 }),
        });
      } catch (apiErr: any) {
        setUploading(false);
        Alert.alert(
          "Decode failed",
          apiErr?.message ||
            "Could not read the barcode on that photo. Please try a clearer, close-up shot of the license disc.",
        );
        return;
      }
      setUploading(false);
      setScanned(json?.raw || "uploaded");
      // Persist BOTH the raw string (may be empty for OCR-only decodes)
      // AND the structured `parsed` object the backend already produced,
      // so submit.tsx picks up VIN/engine/etc. even when the barcode
      // itself couldn't be read and OCR did the extracting.
      await persistAndReturn(json?.raw || "", b64, json?.parsed || {});
    } catch (err: any) {
      setUploading(false);
      Alert.alert("Upload failed", err?.message || "Something went wrong reading the photo.");
    }
  };

  if (!permission) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <TouchableOpacity testID="scan-back-button" onPress={returnToCaller} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Scan License Disk</Text>
          <View style={{ width: 32 }} />
        </View>
        <View style={styles.permissionBox}>
          <Ionicons name="camera" size={64} color={colors.textDisabled} />
          <Text style={styles.permissionTitle}>Camera access needed</Text>
          <Text style={styles.permissionText}>
            Allow camera access to scan license disc barcodes — or upload a photo from your library instead.
          </Text>
          <TouchableOpacity
            testID="request-permission-button"
            style={styles.permBtn}
            onPress={() => {
              if (permission.canAskAgain) {
                requestPermission();
              } else {
                Alert.alert(
                  "Camera Permission",
                  "Please enable camera permissions in Settings to scan license disks.",
                );
              }
            }}
          >
            <Text style={styles.permBtnText}>Grant Access</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="upload-photo-fallback"
            style={styles.uploadBtnAlt}
            onPress={handleUploadPhoto}
            disabled={uploading}
          >
            {uploading ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <>
                <Ionicons name="image-outline" size={20} color={colors.primary} />
                <Text style={styles.uploadBtnAltText}>Upload photo from library</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        ref={(r) => { cameraRef.current = r; }}
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ["pdf417", "qr", "code128", "code39", "ean13", "ean8"],
        }}
        onBarcodeScanned={scanned ? undefined : handleScanned}
      />
      <SafeAreaView style={styles.overlay} edges={["top", "bottom"]}>
        <View style={styles.topBar}>
          <TouchableOpacity testID="scan-close-button" onPress={returnToCaller} style={styles.headerBtn}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.topBarTitle}>Scan License Disk</Text>
          <View style={{ width: 32 }} />
        </View>

        <View style={styles.center}>
          <View style={styles.frame}>
            <View style={[styles.corner, styles.tl]} />
            <View style={[styles.corner, styles.tr]} />
            <View style={[styles.corner, styles.bl]} />
            <View style={[styles.corner, styles.br]} />
          </View>
          <Text style={styles.hint}>
            {scanned ? "Scanned! Returning..." : "Align the barcode within the frame"}
          </Text>
          {scanned ? (
            <TouchableOpacity
              testID="scan-retake-btn"
              onPress={retake}
              style={styles.retakeBtn}
            >
              <Ionicons name="refresh" size={16} color="#fff" />
              <Text style={styles.retakeBtnText}>Retake</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.bottomBar}>
          <Text style={styles.bottomHint}>
            Supports PDF417 (SA license disk) and standard barcodes
          </Text>
          <TouchableOpacity
            testID="upload-photo-btn"
            style={styles.uploadBtn}
            onPress={handleUploadPhoto}
            disabled={uploading}
          >
            {uploading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="image-outline" size={20} color="#fff" />
                <Text style={styles.uploadBtnText}>Upload photo of disc instead</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  safe: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  headerBtn: { padding: 4 },
  headerTitle: { color: "#fff", fontSize: 17, fontWeight: "700" },
  permissionBox: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.sm },
  permissionTitle: { color: colors.text, fontSize: 20, fontWeight: "800", marginTop: spacing.md },
  permissionText: { color: colors.textSecondary, textAlign: "center", fontSize: 14 },
  permBtn: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: 12,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
  },
  permBtnText: { color: "#000", fontWeight: "800", letterSpacing: 1 },
  uploadBtnAlt: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: "transparent",
  },
  uploadBtnAltText: { color: colors.primary, fontWeight: "700" },
  overlay: { flex: 1, backgroundColor: "transparent" },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  topBarTitle: { color: "#fff", fontSize: 17, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  frame: { width: 280, height: 180, position: "relative" },
  corner: { position: "absolute", width: 30, height: 30, borderColor: colors.primary },
  tl: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4 },
  tr: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4 },
  br: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4 },
  hint: { color: "#fff", marginTop: spacing.lg, fontSize: 14, textAlign: "center" },
  retakeBtn: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.55)",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  retakeBtnText: { color: "#fff", fontWeight: "700", fontSize: 13, letterSpacing: 0.5 },
  bottomBar: {
    padding: spacing.md,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    gap: spacing.sm,
  },
  bottomHint: { color: "#DDD", fontSize: 12, textAlign: "center" },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.4)",
    backgroundColor: "rgba(255,255,255,0.08)",
    minWidth: 250,
    justifyContent: "center",
  },
  uploadBtnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
});
