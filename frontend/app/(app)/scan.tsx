import { useState, useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { colors, spacing, radius } from "@/src/theme";
import { storage } from "@/src/utils/storage";

export const SCAN_BUFFER_KEY = "app.scan.buffer";

export default function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState<string | null>(null);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  const handleScanned = async ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(data);
    await storage.setItem(SCAN_BUFFER_KEY, data);
    setTimeout(() => router.back(), 600);
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
          <TouchableOpacity testID="scan-back-button" onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Scan License Disk</Text>
          <View style={{ width: 32 }} />
        </View>
        <View style={styles.permissionBox}>
          <Ionicons name="camera" size={64} color={colors.textDisabled} />
          <Text style={styles.permissionTitle}>Camera access needed</Text>
          <Text style={styles.permissionText}>Allow camera access to scan license disk barcodes.</Text>
          <TouchableOpacity
            testID="request-permission-button"
            style={styles.permBtn}
            onPress={() => {
              if (permission.canAskAgain) {
                requestPermission();
              } else {
                Alert.alert(
                  "Camera Permission",
                  "Please enable camera permissions in Settings to scan license disks."
                );
              }
            }}
          >
            <Text style={styles.permBtnText}>Grant Access</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ["pdf417", "qr", "code128", "code39", "ean13", "ean8"],
        }}
        onBarcodeScanned={scanned ? undefined : handleScanned}
      />
      <SafeAreaView style={styles.overlay} edges={["top", "bottom"]}>
        <View style={styles.topBar}>
          <TouchableOpacity testID="scan-close-button" onPress={() => router.back()} style={styles.headerBtn}>
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
        </View>

        <View style={styles.bottomBar}>
          <Text style={styles.bottomHint}>
            Supports PDF417 (SA license disk) and standard barcodes
          </Text>
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
  permBtnText: { color: "#fff", fontWeight: "700" },
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
  bottomBar: { padding: spacing.md, backgroundColor: "rgba(0,0,0,0.6)" },
  bottomHint: { color: colors.textSecondary, fontSize: 12, textAlign: "center" },
});
