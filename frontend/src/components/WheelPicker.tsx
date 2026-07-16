import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Modal,
  TouchableOpacity,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from "react-native";
import { colors, spacing, radius, fonts } from "@/src/theme";

const ITEM_HEIGHT = 44;
const VISIBLE = 5; // rows visible; center = selected

type Props<T extends string | number> = {
  visible: boolean;
  title: string;
  options: T[];
  value: T | null;
  onSelect: (v: T) => void;
  onClose: () => void;
  formatter?: (v: T) => string;
  testID?: string;
};

/**
 * iOS-style scrolling wheel picker in a bottom sheet.
 * - Options render as a vertical column with `snapToInterval={ITEM_HEIGHT}`.
 * - Center row is the selected one (highlighted with top/bottom rails).
 * - onMomentumScrollEnd snaps and calls `onSelect`.
 * - Uses padding = 2 * ITEM_HEIGHT top/bottom so the first/last item can
 *   reach the center track.
 */
export default function WheelPicker<T extends string | number>({
  visible,
  title,
  options,
  value,
  onSelect,
  onClose,
  formatter,
  testID,
}: Props<T>) {
  const scrollRef = useRef<ScrollView>(null);
  const [current, setCurrent] = useState<T | null>(value ?? options[0] ?? null);

  // Snap to the incoming value whenever the modal opens.
  useEffect(() => {
    if (!visible) return;
    const idx = Math.max(
      0,
      options.findIndex((o) => o === value)
    );
    // Slight delay so ScrollView has laid out on iOS.
    const t = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: idx * ITEM_HEIGHT, animated: false });
      setCurrent(options[idx] ?? options[0] ?? null);
    }, 30);
    return () => clearTimeout(t);
  }, [visible, options, value]);

  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const idx = Math.max(0, Math.min(options.length - 1, Math.round(y / ITEM_HEIGHT)));
    setCurrent(options[idx]);
    // Ensure alignment (some platforms overshoot by a pixel)
    scrollRef.current?.scrollTo({ y: idx * ITEM_HEIGHT, animated: true });
  };

  const confirm = () => {
    if (current != null) onSelect(current);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card} testID={testID}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} testID={`${testID}-cancel`}>
              <Text style={styles.cancel}>CANCEL</Text>
            </TouchableOpacity>
            <Text style={styles.title}>{title}</Text>
            <TouchableOpacity onPress={confirm} testID={`${testID}-done`} disabled={current == null}>
              <Text style={[styles.done, current == null && { opacity: 0.35 }]}>DONE</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.wheelWrap}>
            {/* Selection rails */}
            <View pointerEvents="none" style={styles.rail} />

            <ScrollView
              ref={scrollRef}
              showsVerticalScrollIndicator={false}
              snapToInterval={ITEM_HEIGHT}
              decelerationRate="fast"
              onMomentumScrollEnd={onMomentumEnd}
              contentContainerStyle={{
                paddingVertical: ITEM_HEIGHT * ((VISIBLE - 1) / 2),
              }}
              style={{ height: ITEM_HEIGHT * VISIBLE }}
            >
              {options.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={styles.emptyText}>No options available</Text>
                </View>
              ) : (
                options.map((opt, i) => {
                  const isCurrent = current === opt;
                  return (
                    <View
                      key={`${opt}-${i}`}
                      style={styles.item}
                    >
                      <Text
                        style={[
                          styles.itemText,
                          isCurrent && styles.itemTextActive,
                        ]}
                        numberOfLines={1}
                      >
                        {formatter ? formatter(opt) : String(opt)}
                      </Text>
                    </View>
                  );
                })
              )}
            </ScrollView>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "flex-end" },
  card: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.paper,
  },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 2,
    textTransform: "uppercase",
    flex: 1,
    textAlign: "center",
  },
  cancel: { color: colors.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 1 },
  done: { color: colors.text, fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  wheelWrap: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md, alignItems: "stretch" },
  rail: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    top: spacing.sm + ITEM_HEIGHT * ((VISIBLE - 1) / 2),
    height: ITEM_HEIGHT,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.paper,
  },
  item: {
    height: ITEM_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  itemText: {
    color: colors.textSecondary,
    fontSize: 17,
    fontFamily: fonts.body,
    letterSpacing: 0.3,
  },
  itemTextActive: {
    color: colors.text,
    fontWeight: "800",
  },
  emptyRow: { height: ITEM_HEIGHT, alignItems: "center", justifyContent: "center" },
  emptyText: { color: colors.textDisabled, fontSize: 13 },
});
