/**
 * FlatfileUploader — admin cockpit button + native picker that ships
 * a fresh TransUnion / Kredo flat-file (.xlsx) to
 * `POST /api/admin/vehicle-specs/upload-flatfile`, which re-runs the
 * same conversion the build-time script uses and reseeds the runtime
 * `vehicle_specs` collection so the app immediately runs on the new
 * dictionary — no code deploy required.
 *
 * Web-first (that's where the admin cockpit lives). On mobile we fall
 * back to `expo-document-picker` so an admin on the go can still
 * refresh the flat-file if needed.
 */
import React, { useCallback, useRef, useState } from "react";
import { Alert, Platform, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { apiFetch } from "@/src/api";

const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL || "";

type Result = {
  filename: string;
  file_size_bytes: number;
  deleted: number;
  inserted: number;
  conversion_stats: {
    total_rows_scanned: number;
    kept_variants: number;
    skipped_vehicle_type: number;
    skipped_older_than_min_year: number;
    skipped_duplicate_variants: number;
    min_year: number;
  };
};

export default function FlatfileUploader({
  onDone,
  colors,
  styles,
}: {
  onDone?: () => void;
  colors: any;
  styles: any;
}) {
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const uploadBlob = useCallback(
    async (fileBlob: Blob, filename: string) => {
      setBusy(true);
      try {
        const form = new FormData();
        // React Native's fetch understands a Blob-with-name on web
        // and a `{ uri, name, type }` object on native; the wrapper
        // in `apiFetch` forwards `body` untouched, so we build both
        // depending on platform.
        // @ts-ignore — FormData.append second arg accepts Blob in DOM
        form.append("file", fileBlob, filename);
        const res = (await apiFetch(
          "/api/admin/vehicle-specs/upload-flatfile",
          {
            method: "POST",
            body: form as any,
            // Let the browser/native runtime set the multipart boundary.
            headers: { Accept: "application/json" },
          },
        )) as Result;
        const stats = res.conversion_stats;
        Alert.alert(
          "Flat-file loaded",
          [
            `File: ${res.filename} (${Math.round(res.file_size_bytes / 1024)} KB)`,
            `Kept variants: ${stats.kept_variants.toLocaleString()}`,
            `Scanned rows: ${stats.total_rows_scanned.toLocaleString()}`,
            `Skipped (old/dup/wrong type): ${(
              stats.skipped_vehicle_type +
              stats.skipped_older_than_min_year +
              stats.skipped_duplicate_variants
            ).toLocaleString()}`,
            `DB rows: replaced ${res.deleted.toLocaleString()}, inserted ${res.inserted.toLocaleString()}`,
            `Min year kept: ${stats.min_year}`,
          ].join("\n"),
        );
        if (onDone) onDone();
      } catch (e: any) {
        Alert.alert(
          "Upload failed",
          e?.message || "Something went wrong — check the file is the correct .xlsx flat-file.",
        );
      } finally {
        setBusy(false);
      }
    },
    [onDone],
  );

  const handlePress = useCallback(async () => {
    if (busy) return;
    if (Platform.OS === "web") {
      // Trigger the hidden input; onChange handles the actual upload.
      fileInputRef.current?.click();
      return;
    }
    // Native fallback via expo-document-picker
    try {
      const DocumentPicker = await import("expo-document-picker");
      const picked = await DocumentPicker.getDocumentAsync({
        type: [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-excel.sheet.macroEnabled.12",
        ],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (picked.canceled || !picked.assets?.[0]) return;
      const asset = picked.assets[0];
      // Convert file uri → Blob for FormData upload.
      const resp = await fetch(asset.uri);
      const blob = await resp.blob();
      await uploadBlob(blob, asset.name || "flatfile.xlsx");
    } catch (e: any) {
      Alert.alert("Picker error", e?.message || "Could not open file picker on this device.");
    }
  }, [busy, uploadBlob]);

  const handleWebChange = useCallback(
    async (ev: any) => {
      const file: File | undefined = ev?.target?.files?.[0];
      if (!file) return;
      await uploadBlob(file, file.name);
      // Reset so the same file can be re-picked if needed.
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [uploadBlob],
  );

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <TouchableOpacity
        testID="cockpit-upload-flatfile"
        style={[
          styles.mtdRefreshBtn,
          {
            backgroundColor: colors.primary,
            borderColor: colors.primary,
          },
          busy && { opacity: 0.6 },
        ]}
        onPress={handlePress}
        disabled={busy}
        accessibilityLabel="Upload TransUnion flat-file"
      >
        <Ionicons
          name={busy ? "hourglass-outline" : "cloud-upload-outline"}
          size={14}
          color={colors.onPrimary}
        />
        <Text style={[styles.mtdRefreshText, { color: colors.onPrimary }]}>
          {busy ? "Uploading…" : "Upload flat-file"}
        </Text>
      </TouchableOpacity>
      {Platform.OS === "web" ? (
        // Hidden native <input type="file"> — RN Web doesn't ship a
        // proper file picker so we roll our own. Only present on web
        // renders (React Native ignores the JSX in native builds).
        // @ts-ignore — DOM element rendered via RN Web
        <input
          ref={fileInputRef as any}
          type="file"
          accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={handleWebChange}
          style={{ display: "none" }}
        />
      ) : null}
    </View>
  );
}

export { BACKEND };
