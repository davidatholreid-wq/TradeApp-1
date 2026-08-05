import React, { useEffect, useRef, useState, useMemo } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, Modal, NativeSyntheticEvent, NativeScrollEvent, Platform, TextInput } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";

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
 * Cross-platform picker in a bottom sheet.
 *
 *  - **Native (iOS / Android)** — iOS-style scrolling wheel with
 *    `snapToInterval` and `onMomentumScrollEnd` snap. Center rail is
 *    the selection.
 *  - **Web** — tap-to-select list with a search filter. The wheel
 *    scroll-snap UX is unreliable in browsers (trackpad / mouse-wheel
 *    momentum doesn't fire snap events consistently, and users
 *    naturally expect to click a value). We render an accessible list
 *    of tappable rows instead; picking a row selects the value and
 *    closes the sheet.
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
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const scrollRef = useRef<ScrollView>(null);
  const [current, setCurrent] = useState<T | null>(value ?? options[0] ?? null);
  const [query, setQuery] = useState("");

  // Reset filter every time the sheet opens so users don't return to
  // a stale search from a previous session.
  useEffect(() => {
    if (visible) setQuery("");
  }, [visible]);

  // Snap the wheel to the incoming value on open (native only — on
  // web the list scrolls naturally to the highlighted row via
  // scrollIntoView below).
  useEffect(() => {
    if (!visible) return;
    if (Platform.OS === "web") {
      setCurrent(value ?? options[0] ?? null);
      return;
    }
    const idx = Math.max(
      0,
      options.findIndex((o) => o === value)
    );
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
    scrollRef.current?.scrollTo({ y: idx * ITEM_HEIGHT, animated: true });
  };

  const confirm = () => {
    if (current != null) onSelect(current);
    onClose();
  };

  // Filtered list — case-insensitive substring match on the display
  // string (either `formatter(opt)` or `String(opt)`). Only used on web.
  const q = query.trim().toLowerCase();
  const shown = q
    ? options.filter((o) => (formatter ? formatter(o) : String(o)).toLowerCase().includes(q))
    : options;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card} testID={testID}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} testID={`${testID}-cancel`}>
              <Text style={styles.cancel}>CANCEL</Text>
            </TouchableOpacity>
            <Text style={styles.title}>{title}</Text>
            {Platform.OS === "web" ? (
              // On web the row-tap already selects and closes, so the
              // top-right chevron is purely a visual balance.
              <View style={{ width: 60 }} />
            ) : (
              <TouchableOpacity onPress={confirm} testID={`${testID}-done`} disabled={current == null}>
                <Text style={[styles.done, current == null && { opacity: 0.35 }]}>DONE</Text>
              </TouchableOpacity>
            )}
          </View>

          {Platform.OS === "web" ? (
            <View style={styles.webWrap}>
              {options.length > 8 ? (
                <View style={styles.searchWrap}>
                  <Ionicons name="search" size={14} color={colors.textSecondary} />
                  <TextInput
                    testID={`${testID}-search`}
                    value={query}
                    onChangeText={setQuery}
                    placeholder={`Search ${title.toLowerCase()}…`}
                    placeholderTextColor={colors.textDisabled}
                    style={styles.searchInput}
                    autoFocus
                  />
                  {query ? (
                    <TouchableOpacity onPress={() => setQuery("")}>
                      <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
              <ScrollView style={styles.webList} keyboardShouldPersistTaps="handled">
                {shown.length === 0 ? (
                  <View style={styles.emptyRowWeb}>
                    <Text style={styles.emptyText}>
                      {options.length === 0 ? "No options available" : "No matches — try a different search."}
                    </Text>
                  </View>
                ) : (
                  shown.map((opt, i) => {
                    const isSelected = value === opt;
                    return (
                      <TouchableOpacity
                        key={`${opt}-${i}`}
                        testID={`${testID}-row-${i}`}
                        style={[
                          styles.webRow,
                          isSelected && { backgroundColor: colors.primary + "22", borderLeftColor: colors.primary, borderLeftWidth: 3 },
                        ]}
                        onPress={() => {
                          onSelect(opt);
                          onClose();
                        }}
                      >
                        <Text
                          style={[
                            styles.webRowText,
                            isSelected && { color: colors.text, fontWeight: "800" },
                          ]}
                          numberOfLines={1}
                        >
                          {formatter ? formatter(opt) : String(opt)}
                        </Text>
                        {isSelected ? (
                          <Ionicons name="checkmark" size={18} color={colors.primary} />
                        ) : null}
                      </TouchableOpacity>
                    );
                  })
                )}
              </ScrollView>
            </View>
          ) : (
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
                      <TouchableOpacity
                        key={`${opt}-${i}`}
                        style={styles.item}
                        onPress={() => {
                          setCurrent(opt);
                          scrollRef.current?.scrollTo({ y: i * ITEM_HEIGHT, animated: true });
                        }}
                        activeOpacity={0.7}
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
                      </TouchableOpacity>
                    );
                  })
                )}
              </ScrollView>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "flex-end" },
  card: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    overflow: "hidden",
    maxWidth: 720,
    width: "100%",
    alignSelf: "center",
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
  emptyRowWeb: { paddingVertical: spacing.xl, alignItems: "center" },
  emptyText: { color: colors.textDisabled, fontSize: 13 },
  // Web-only styles ----------------------------------------------------
  webWrap: {
    // Cap the height so the list becomes internally scrollable rather
    // than pushing the modal off-screen when there are 300+ models.
    maxHeight: 480,
  },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    // @ts-ignore — RN Web accepts `outlineStyle`.
    outlineStyle: "none",
  },
  webList: {
    marginTop: spacing.sm,
    // paddingBottom keeps the last row above the safe-area bottom
    // when the modal is short.
    paddingBottom: spacing.md,
  },
  webRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    borderLeftColor: "transparent",
    borderLeftWidth: 3,
  },
  webRowText: {
    color: colors.textSecondary,
    fontSize: 15,
    letterSpacing: 0.2,
    flex: 1,
  },
});
