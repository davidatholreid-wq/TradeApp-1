import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, ScrollView, Modal, NativeSyntheticEvent, NativeScrollEvent, Platform } from "react-native";
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
  const webScrollRef = useRef<any>(null);          // RN Web ScrollView instance
  const scrollDebounceRef = useRef<any>(null);
  const lastScrollY = useRef<number>(0);           // tracked in onScroll for both platforms
  const [current, setCurrent] = useState<T | null>(value ?? options[0] ?? null);

  // Sync the wheel to the incoming value on open (BOTH platforms use
  // the same scroll-snap layout).
  useEffect(() => {
    if (!visible) return;
    const idx = Math.max(0, options.findIndex((o) => o === value));
    const snapIndex = idx === -1 ? 0 : idx;
    setCurrent(options[snapIndex] ?? options[0] ?? null);
    lastScrollY.current = snapIndex * ITEM_HEIGHT;
    const t = setTimeout(() => {
      if (Platform.OS === "web") {
        try {
          webScrollRef.current?.scrollTo?.({ y: snapIndex * ITEM_HEIGHT, animated: false });
        } catch {}
      } else {
        scrollRef.current?.scrollTo({ y: snapIndex * ITEM_HEIGHT, animated: false });
      }
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, value, options.length]);

  // Native — read scroll offset when momentum stops and snap to it.
  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    lastScrollY.current = y;
    const idx = Math.max(0, Math.min(options.length - 1, Math.round(y / ITEM_HEIGHT)));
    setCurrent(options[idx]);
    scrollRef.current?.scrollTo({ y: idx * ITEM_HEIGHT, animated: true });
  };

  // Web — react-native-web ScrollView passes a synthetic event whose
  // `nativeEvent.contentOffset.y` is populated (same shape as native).
  // We track the latest y in a ref (survives the debounce) so `confirm`
  // can commit the exact position the user landed on.
  const onWebScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e?.nativeEvent?.contentOffset?.y ?? 0;
      lastScrollY.current = y;
      if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
      scrollDebounceRef.current = setTimeout(() => {
        const idx = Math.max(0, Math.min(options.length - 1, Math.round(y / ITEM_HEIGHT)));
        setCurrent(options[idx] ?? null);
      }, 130);
    },
    [options],
  );

  const scrollToIndex = (i: number) => {
    lastScrollY.current = i * ITEM_HEIGHT;
    if (Platform.OS === "web") {
      try {
        webScrollRef.current?.scrollTo?.({ y: i * ITEM_HEIGHT, animated: true });
      } catch {}
    } else {
      scrollRef.current?.scrollTo({ y: i * ITEM_HEIGHT, animated: true });
    }
    setCurrent(options[i]);
  };

  const confirm = () => {
    // Read the tracked scroll offset (populated on every onScroll fire)
    // instead of poking the DOM — RN Web's ScrollView ref exposes RN
    // methods, not the underlying div's `scrollTop`, so DOM reads
    // returned undefined → NaN → forced to top. This lets us commit
    // the row the user actually landed on even if DONE was tapped
    // inside the debounce window.
    const y = lastScrollY.current || 0;
    const idx = Math.max(0, Math.min(options.length - 1, Math.round(y / ITEM_HEIGHT)));
    const final = options[idx] ?? current;
    if (final != null) onSelect(final);
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
});
