import { useEffect, useRef, useState, useMemo } from "react";
import { Pressable, TouchableOpacity } from "@/src/components/HapticButtons";
import { View, Text, StyleSheet, Modal, Image, ScrollView, useWindowDimensions, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, radius, fonts } from "@/src/theme";
import { useThemeColors, type Palette } from "@/src/theme/ThemeContext";

export type CarouselPhoto = { uri: string; label: string };

type Props = {
  photos: CarouselPhoto[];
  initialIndex: number;
  visible: boolean;
  onClose: () => void;
};

// Fullscreen swipeable photo carousel with monochrome chrome — used on both
// the mobile admin detail view and the desktop cockpit.
export default function PhotoCarousel({ photos, initialIndex, visible, onClose }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width, height } = useWindowDimensions();
  const scrollRef = useRef<ScrollView | null>(null);
  const [index, setIndex] = useState(initialIndex);

  // When the modal opens, jump instantly to the requested photo without an
  // animation — the user tapped a thumbnail so they expect the same photo.
  useEffect(() => {
    if (!visible) return;
    setIndex(initialIndex);
    // Defer to next tick so the ScrollView has laid out at the correct width.
    const t = setTimeout(() => {
      scrollRef.current?.scrollTo({ x: initialIndex * width, y: 0, animated: false });
    }, 0);
    return () => clearTimeout(t);
  }, [visible, initialIndex, width]);

  const goTo = (i: number) => {
    const clamped = Math.max(0, Math.min(photos.length - 1, i));
    setIndex(clamped);
    scrollRef.current?.scrollTo({ x: clamped * width, y: 0, animated: true });
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      supportedOrientations={["portrait", "landscape"]}
    >
      <View style={styles.root} testID="photo-carousel">
        {/* Top bar */}
        <View style={styles.topBar}>
          <View style={styles.topBarLeft}>
            <Text style={styles.counter}>
              {photos.length > 0 ? `${index + 1} / ${photos.length}` : "0 / 0"}
            </Text>
            <Text style={styles.label} numberOfLines={1}>
              {photos[index]?.label?.toUpperCase() ?? ""}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.closeBtn}
            onPress={onClose}
            testID="photo-carousel-close"
            accessibilityLabel="Close photo carousel"
          >
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Slides */}
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(e) => {
            const i = Math.round(e.nativeEvent.contentOffset.x / width);
            if (i !== index) setIndex(i);
          }}
          style={{ flex: 1 }}
        >
          {photos.map((p, i) => (
            <Pressable
              key={i}
              onPress={onClose}
              style={{ width, height: height - 120, alignItems: "center", justifyContent: "center" }}
            >
              <Image
                source={{ uri: p.uri }}
                style={{ width: width - spacing.md * 2, height: height - 160 }}
                resizeMode="contain"
              />
            </Pressable>
          ))}
        </ScrollView>

        {/* Prev / Next arrows — only render on wide viewports (desktop) */}
        {Platform.OS === "web" && width > 720 ? (
          <>
            {index > 0 ? (
              <TouchableOpacity
                style={[styles.arrow, styles.arrowLeft]}
                onPress={() => goTo(index - 1)}
                testID="photo-carousel-prev"
              >
                <Ionicons name="chevron-back" size={32} color="#fff" />
              </TouchableOpacity>
            ) : null}
            {index < photos.length - 1 ? (
              <TouchableOpacity
                style={[styles.arrow, styles.arrowRight]}
                onPress={() => goTo(index + 1)}
                testID="photo-carousel-next"
              >
                <Ionicons name="chevron-forward" size={32} color="#fff" />
              </TouchableOpacity>
            ) : null}
          </>
        ) : null}

        {/* Dots + thumbnail strip */}
        <View style={styles.bottomBar}>
          <View style={styles.dotsRow}>
            {photos.map((_, i) => (
              <View
                key={i}
                style={[styles.dot, i === index && styles.dotActive]}
              />
            ))}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.thumbStrip}
          >
            {photos.map((p, i) => (
              <TouchableOpacity
                key={i}
                onPress={() => goTo(i)}
                style={[styles.thumb, i === index && styles.thumbActive]}
                testID={`photo-carousel-thumb-${i}`}
              >
                <Image source={{ uri: p.uri }} style={styles.thumbImg} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: "rgba(0,0,0,0.97)" },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    paddingTop: Platform.OS === "ios" ? 54 : spacing.lg,
    backgroundColor: "rgba(0,0,0,0.85)",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  topBarLeft: { flexDirection: "row", alignItems: "center", gap: spacing.md, flex: 1 },
  counter: {
    color: "#fff",
    fontFamily: fonts.mono,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1.5,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 2,
    flex: 1,
  },
  closeBtn: { padding: 8 },
  arrow: {
    position: "absolute",
    top: "50%",
    marginTop: -24,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.6)",
    borderWidth: 1,
    borderColor: colors.border,
  },
  arrowLeft: { left: 16 },
  arrowRight: { right: 16 },
  bottomBar: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: "rgba(0,0,0,0.85)",
    gap: spacing.sm,
  },
  dotsRow: { flexDirection: "row", justifyContent: "center", gap: 6 },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
  },
  dotActive: { backgroundColor: "#fff", width: 20 },
  thumbStrip: { gap: spacing.sm, alignItems: "center", paddingHorizontal: 4 },
  thumb: {
    width: 52,
    height: 40,
    borderRadius: radius.sm,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    opacity: 0.5,
  },
  thumbActive: { borderColor: "#fff", opacity: 1 },
  thumbImg: { width: "100%", height: "100%" },
});
