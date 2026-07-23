/**
 * Drop-in haptic-enabled wrappers for React Native's `TouchableOpacity`
 * and `Pressable`.
 *
 * We deliberately export identifiers with the SAME names as the
 * upstream RN components. This lets a codemod flip only the import
 * source — call-sites and JSX stay untouched, which keeps `git blame`
 * clean and dramatically reduces the risk surface of enabling haptics
 * app-wide.
 *
 * Behaviour:
 *   - Every `onPress` fires a light haptic tick BEFORE the original
 *     handler runs. Errors from `expo-haptics` are swallowed inside
 *     `hapticTap` so they never block the tap.
 *   - `disabled` presses do not fire haptics (RN swallows onPress in
 *     that case; our wrapper never sees the call, so this is free).
 *   - Every other prop is forwarded transparently — including `ref`,
 *     accessibility props, style callbacks (Pressable's `style` may be
 *     a function of press state), and `onLongPress` (which also gets a
 *     stronger haptic since long-presses are usually destructive
 *     confirmations in mobile UI).
 */
import React, { forwardRef, useCallback } from "react";
import {
  TouchableOpacity as RNTouchableOpacity,
  Pressable as RNPressable,
  TouchableOpacityProps,
  PressableProps,
  GestureResponderEvent,
  View,
} from "react-native";
import { hapticTap, hapticHeavy } from "@/src/utils/haptics";

// ---------------------------------------------------------------------------
// TouchableOpacity
// ---------------------------------------------------------------------------
export const TouchableOpacity = forwardRef<View, TouchableOpacityProps>(
  ({ onPress, onLongPress, ...rest }, ref) => {
    const handlePress = useCallback(
      (e: GestureResponderEvent) => {
        hapticTap();
        onPress?.(e);
      },
      [onPress]
    );
    const handleLongPress = useCallback(
      (e: GestureResponderEvent) => {
        hapticHeavy();
        onLongPress?.(e);
      },
      [onLongPress]
    );
    return (
      <RNTouchableOpacity
        ref={ref as any}
        onPress={onPress ? handlePress : undefined}
        onLongPress={onLongPress ? handleLongPress : undefined}
        {...rest}
      />
    );
  }
);
TouchableOpacity.displayName = "HapticTouchableOpacity";

// ---------------------------------------------------------------------------
// Pressable
// ---------------------------------------------------------------------------
export const Pressable = forwardRef<View, PressableProps>(
  ({ onPress, onLongPress, ...rest }, ref) => {
    const handlePress = useCallback(
      (e: GestureResponderEvent) => {
        hapticTap();
        onPress?.(e);
      },
      [onPress]
    );
    const handleLongPress = useCallback(
      (e: GestureResponderEvent) => {
        hapticHeavy();
        onLongPress?.(e);
      },
      [onLongPress]
    );
    return (
      <RNPressable
        ref={ref as any}
        onPress={onPress ? handlePress : undefined}
        onLongPress={onLongPress ? handleLongPress : undefined}
        {...rest}
      />
    );
  }
);
Pressable.displayName = "HapticPressable";
