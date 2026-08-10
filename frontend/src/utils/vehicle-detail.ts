/**
 * Vehicle-detail helpers shared between the mobile `vehicle/[id].tsx`
 * detail page and the web `WebAdminDashboard.tsx` admin cockpit.
 *
 * Extracted 2026-08-09 as part of a small, low-risk file-hygiene pass
 * so both call sites use one canonical implementation and the
 * vehicle-detail file no longer duplicates these utility helpers.
 */

import { Alert, Platform } from "react-native";

/**
 * Pick a photo out of a `{key: base64/url}` map, falling back to a
 * second key if the primary one is missing. Tolerates undefined maps
 * so callers don't need to null-check before invoking.
 */
export function resolvePhoto(
  photos: Record<string, string> | undefined | null,
  key: string,
  fallback?: string,
): string {
  if (!photos) return "";
  return photos[key] || (fallback ? photos[fallback] : "") || "";
}

/** Format a Kredo market-value amount in R with no decimals. */
export function formatMV(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v) || v === 0) return "—";
  return `R${Number(v).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`;
}

/** Compact "fetched X ago" label for the Kredo market-values footer. */
export function formatFetched(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  try {
    const d = typeof iso === "string" ? new Date(iso) : iso;
    if (Number.isNaN(d.getTime())) return "";
    const diffSec = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return "just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hr ago`;
    return d.toLocaleDateString("en-ZA");
  } catch {
    return "";
  }
}

/**
 * Cross-platform "OK / Cancel" confirmation.
 *
 * `Alert.alert(title, msg, buttons)` renders the buttons natively on iOS/
 * Android, but the react-native-web implementation shows the message and
 * silently drops the buttons — so on the web preview the user has no way
 * to confirm or cancel. This helper falls back to `window.confirm` on web
 * so flows like admin pricing / deletion / report ordering still work
 * there.
 */
export function confirmAsync(
  title: string,
  message: string,
  confirmLabel = "Confirm",
): Promise<boolean> {
  return new Promise((resolve) => {
    if (Platform.OS === "web") {
      const combined = title ? `${title}\n\n${message}` : message;
      const ok = typeof window !== "undefined" && window.confirm(combined);
      resolve(ok);
      return;
    }
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: confirmLabel, style: "default", onPress: () => resolve(true) },
    ]);
  });
}
