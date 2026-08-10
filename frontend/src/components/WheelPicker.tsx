import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, Modal, NativeSyntheticEvent, NativeScrollEvent, Platform, TextInput } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";

const ITEM_HEIGHT = 44;
const VISIBLE = 5; // rows visible; center = selected
const PAD_ROWS = (VISIBLE - 1) / 2; // 2 rows of blank padding each side

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
 *  - **Web (mobile & desktop)** — same wheel UX, implemented with CSS
 *    `scroll-snap-type: y mandatory` so touch-scroll on iOS Safari /
 *    Android Chrome behaves natively, and a debounced `onScroll`
 *    handler picks up the settled position for mouse-wheel users on
 *    desktop. Tap a row to smooth-scroll it to the center.
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
  const webScrollRef = useRef<any>(null);          // underlying DOM node on web
  const scrollDebounceRef = useRef<any>(null);
  const [current, setCurrent] = useState<T | null>(value ?? options[0] ?? null);
  const [query, setQuery] = useState("");

  // Reset filter every time the sheet opens so users don't return to
  // a stale search from a previous session.
  useEffect(() => {
    if (visible) setQuery("");
  }, [visible]);

  // Filtered list — case-insensitive substring match on the display
  // string (either `formatter(opt)` or `String(opt)`). Only shown when
  // the caller passes more than 8 options.
  const q = query.trim().toLowerCase();
  const shown = q
    ? options.filter((o) => (formatter ? formatter(o) : String(o)).toLowerCase().includes(q))
    : options;

  // Sync the wheel to the incoming value on open (BOTH platforms — the
  // web wheel uses the same scroll-snap layout as native so it needs
  // the same initial snap).
  useEffect(() => {
    if (!visible) return;
    const idx = Math.max(0, shown.findIndex((o) => o === value));
    const snapIndex = idx === -1 ? 0 : idx;
    const t = setTimeout(() => {
      if (Platform.OS === "web") {
        try {
          webScrollRef.current?.scrollTo?.({ top: snapIndex * ITEM_HEIGHT, behavior: "auto" });
        } catch {}
      } else {
        scrollRef.current?.scrollTo({ y: snapIndex * ITEM_HEIGHT, animated: false });
      }
      setCurrent(shown[snapIndex] ?? shown[0] ?? null);
    }, 30);
    return () => clearTimeout(t);
    // Re-run when the visible/values change; on filter change reset to top.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, value, shown.length]);

  // Native — read scroll offset when momentum stops and snap to it.
  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const idx = Math.max(0, Math.min(shown.length - 1, Math.round(y / ITEM_HEIGHT)));
    setCurrent(shown[idx]);
    scrollRef.current?.scrollTo({ y: idx * ITEM_HEIGHT, animated: true });
  };

  // Web — debounced onScroll to detect the settled position. Fires
  // 130ms after the last scroll event which is long enough for
  // scroll-snap CSS to snap to the target row on both touch (iOS
  // momentum) and mouse-wheel (desktop).
  const onWebScroll = useCallback(
    (e: any) => {
      const target = e?.currentTarget || e?.target;
      if (!target) return;
      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
      scrollDebounceRef.current = setTimeout(() => {
        const y = target.scrollTop || 0;
        const idx = Math.max(0, Math.min(shown.length - 1, Math.round(y / ITEM_HEIGHT)));
        setCurrent(shown[idx] ?? null);
      }, 130);
    },
    [shown],
  );

  const scrollToIndex = (i: number) => {
    if (Platform.OS === "web") {
      try {
        webScrollRef.current?.scrollTo?.({ top: i * ITEM_HEIGHT, behavior: "smooth" });
      } catch {}
    } else {
      scrollRef.current?.scrollTo({ y: i * ITEM_HEIGHT, animated: true });
    }
    setCurrent(shown[i]);
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

          {/* Optional search — shown for lists of >8 options so users can
              type a make/model instead of scrolling through 200+ rows. */}
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
              />
              {query ? (
                <TouchableOpacity onPress={() => setQuery("")}>
                  <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          {Platform.OS === "web" ? (
            /* -------- WEB WHEEL — CSS scroll-snap based -------- */
            <View style={styles.wheelWrap}>
              {/* Fixed selection rail (top + bottom border) */}
              <View pointerEvents="none" style={styles.rail} />

              {/* Fade edges */}
              <View pointerEvents="none" style={styles.fadeTop} />
              <View pointerEvents="none" style={styles.fadeBottom} />

              <ScrollView
                ref={webScrollRef as any}
                showsVerticalScrollIndicator={false}
                onScroll={onWebScroll}
                scrollEventThrottle={16}
                style={[
                  { height: ITEM_HEIGHT * VISIBLE },
                  // React-native-web accepts arbitrary CSS via style. The
                  // `scroll-snap-*` props give us the native-feel snap
                  // on iOS Safari / Android Chrome for free.
                  {
                    scrollSnapType: "y mandatory",
                    // @ts-ignore — DOM-only prop.
                    WebkitOverflowScrolling: "touch",
                    overscrollBehavior: "contain",
                  } as any,
                ]}
                contentContainerStyle={{
                  paddingTop: ITEM_HEIGHT * PAD_ROWS,
                  paddingBottom: ITEM_HEIGHT * PAD_ROWS,
                }}
              >
                {shown.length === 0 ? (
                  <View style={styles.emptyRow}>
                    <Text style={styles.emptyText}>
                      {options.length === 0 ? "No options available" : "No matches"}
                    </Text>
                  </View>
                ) : (
                  shown.map((opt, i) => {
                    const isCurrent = current === opt;
                    return (
                      <TouchableOpacity
                        key={`${opt}-${i}`}
                        testID={`${testID}-row-${i}`}
                        style={[
                          styles.item,
                          // @ts-ignore — DOM-only prop.
                          { scrollSnapAlign: "center", scrollSnapStop: "always" } as any,
                        ]}
                        onPress={() => scrollToIndex(i)}
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
          ) : (
            /* -------- NATIVE WHEEL -------- */
            <View style={styles.wheelWrap}>
              <View pointerEvents="none" style={styles.rail} />

              <ScrollView
                ref={scrollRef}
                showsVerticalScrollIndicator={false}
                snapToInterval={ITEM_HEIGHT}
                decelerationRate="fast"
                onMomentumScrollEnd={onMomentumEnd}
                contentContainerStyle={{
                  paddingVertical: ITEM_HEIGHT * PAD_ROWS,
                }}
                style={{ height: ITEM_HEIGHT * VISIBLE }}
              >
                {shown.length === 0 ? (
                  <View style={styles.emptyRow}>
                    <Text style={styles.emptyText}>
                      {options.length === 0 ? "No options available" : "No matches"}
                    </Text>
                  </View>
                ) : (
                  shown.map((opt, i) => {
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
  wheelWrap: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md, alignItems: "stretch", position: "relative" },
  rail: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    top: spacing.sm + ITEM_HEIGHT * PAD_ROWS,
    height: ITEM_HEIGHT,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.paper,
  },
  fadeTop: {
    position: "absolute",
    left: 0, right: 0,
    top: spacing.sm,
    height: ITEM_HEIGHT * PAD_ROWS,
    backgroundColor: colors.card,
    opacity: 0.65,
    zIndex: 2,
  },
  fadeBottom: {
    position: "absolute",
    left: 0, right: 0,
    top: spacing.sm + ITEM_HEIGHT * (PAD_ROWS + 1),
    height: ITEM_HEIGHT * PAD_ROWS,
    backgroundColor: colors.card,
    opacity: 0.65,
    zIndex: 2,
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
  emptyRow: { height: ITEM_HEIGHT * VISIBLE, alignItems: "center", justifyContent: "center" },
  emptyText: { color: colors.textDisabled, fontSize: 13 },

  // Search — shown on both platforms when options.length > 8.
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
});
