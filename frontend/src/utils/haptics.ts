/**
 * Central haptic-feedback helpers.
 *
 * We route every UI-triggered tap through this module so the whole app
 * has a consistent feel and we have exactly ONE place to tune haptic
 * intensity or disable feedback (for accessibility) later.
 *
 * Haptics are fire-and-forget: we deliberately swallow every error so a
 * missing platform capability (older Android device, web preview, etc.)
 * NEVER blocks the underlying `onPress` from running.
 */
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

// Web has no native haptic support — no-op there so we don't waste JS
// cycles or spam warnings.
const isNative = Platform.OS === "ios" || Platform.OS === "android";

function safe<T>(fn: () => Promise<T> | T) {
  if (!isNative) return;
  try {
    const r = fn();
    if (r && typeof (r as any).catch === "function") (r as any).catch(() => {});
  } catch {
    /* no-op */
  }
}

/** Light tap — use for every plain button / list-row / card press. */
export const hapticTap = () =>
  safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));

/** Medium tap — use for primary CTAs (Submit, Sign In, Continue). */
export const hapticPrimary = () =>
  safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));

/** Heavier tap — use for destructive actions (Delete, Deactivate). */
export const hapticHeavy = () =>
  safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));

/** Selection tick — use for segment / picker / tab changes. */
export const hapticSelect = () => safe(() => Haptics.selectionAsync());

/** Notification-style feedback for state changes. */
export const hapticSuccess = () =>
  safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
export const hapticWarning = () =>
  safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
export const hapticError = () =>
  safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
