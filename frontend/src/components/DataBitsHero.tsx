/**
 * Data-bit assembly animation for the home-screen hero.
 *
 * Effect: ~40 small square "chips" drift in from random off-screen
 * positions (rotated, faded, slightly scaled), coalesce into a tidy
 * 5×8 grid in the centre and then crossfade to reveal the TRADE AI
 * wordmark PNG behind them. After a short pause the whole sequence
 * loops so the hero feels alive without being distracting.
 *
 * Built with `react-native-reanimated` v4 so every keyframe runs on
 * the UI thread — no JS jank even mid-scroll — and it renders
 * identically on iOS, Android and React Native Web (so the video
 * fallback that used to be needed on Web is gone).
 */
import { useEffect, useMemo } from "react";
import { View, StyleSheet, Image, Dimensions } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withDelay,
  withTiming,
  Easing,
  interpolate,
} from "react-native-reanimated";
import { BRAND } from "@/src/theme";

// Grid = COLS × ROWS chips. 5 columns × 8 rows keeps the assembled
// square dense enough to feel like "resolved pixels" without pushing
// the number of Animated views past what RN Web can comfortably
// juggle at 60 fps.
const COLS = 5;
const ROWS = 8;
const CHIP_COUNT = COLS * ROWS;
// Total cycle length. Assembly (1.4s) → hold assembled + reveal logo
// (2.4s) → fade back to chips (0.6s) → hold looping.
const CYCLE_MS = 5200;

export default function DataBitsHero({
  height = 220,
  chipColor = "#22D3EE",
}: {
  height?: number;
  chipColor?: string;
}) {
  // A single shared value drives the whole animation as a 0→1 progress
  // ramp. Individual chips read it via `useAnimatedStyle` so we don't
  // have to wire up 40 separate SharedValues.
  const progress = useSharedValue(0);

  useEffect(() => {
    // Kick off an infinite loop: 0 → 1 → 0 → 0 (hold) etc.
    progress.value = withRepeat(
      withSequence(
        withTiming(1, { duration: CYCLE_MS * 0.35, easing: Easing.out(Easing.cubic) }),
        withDelay(
          CYCLE_MS * 0.45,
          withTiming(0, { duration: CYCLE_MS * 0.12, easing: Easing.in(Easing.cubic) }),
        ),
        // Small pause between loops so it doesn't feel frantic.
        withDelay(CYCLE_MS * 0.08, withTiming(0, { duration: 0 })),
      ),
      -1,
      false,
    );
    // Cleanup — Reanimated cancels on unmount but explicit is nicer.
    return () => {
      progress.value = 0;
    };
  }, [progress]);

  // Pre-compute the per-chip layout + scatter vectors once. Random
  // values are frozen at mount so the animation is deterministic
  // (same chip → same in/out trajectory every loop).
  const chips = useMemo(() => {
    const screenW = Dimensions.get("window").width;
    // Assembled grid is a square roughly 40% of the container width.
    const gridSize = Math.min(220, screenW * 0.36);
    const chipGap = 4;
    const chipW = (gridSize - chipGap * (COLS - 1)) / COLS;
    const chipH = (height * 0.6 - chipGap * (ROWS - 1)) / ROWS;
    const gridOriginX = -gridSize / 2 + chipW / 2;
    const gridOriginY = -(chipH * ROWS + chipGap * (ROWS - 1)) / 2 + chipH / 2;
    return Array.from({ length: CHIP_COUNT }, (_, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      // Scatter start position — random-looking but deterministic.
      const angle = (i * 137.508 * Math.PI) / 180; // golden-angle spiral
      const scatterR = 180 + (i % 7) * 22;
      return {
        chipW,
        chipH,
        // Final assembled position, relative to hero centre.
        endX: gridOriginX + col * (chipW + chipGap),
        endY: gridOriginY + row * (chipH + chipGap),
        // Scatter position — starts off from the assembled grid.
        startX: Math.cos(angle) * scatterR,
        startY: Math.sin(angle) * scatterR,
        // Slight per-chip delay so they don't all arrive on the same
        // frame — creates a natural "cascade" effect.
        delay: (i / CHIP_COUNT) * 0.35,
        rotStart: (i % 2 === 0 ? 1 : -1) * (30 + (i % 5) * 20),
      };
    });
  }, [height]);

  return (
    <View style={[styles.wrap, { height }]}> 
      {/* Underlying wordmark that the chips assemble into. Fades in
          once the chips are locked in place. */}
      <ResolvedLogo progress={progress} height={height} />

      {/* Data chips overlay. Each chip is an absolutely-positioned
          Animated.View driven by the shared `progress` ramp. */}
      <View style={styles.chipsLayer} pointerEvents="none">
        {chips.map((c, i) => (
          <Chip key={i} progress={progress} spec={c} color={chipColor} />
        ))}
      </View>
    </View>
  );
}

/** Single animated chip. */
function Chip({
  progress,
  spec,
  color,
}: {
  progress: Animated.SharedValue<number>;
  spec: ReturnType<() => any>;
  color: string;
}) {
  const style = useAnimatedStyle(() => {
    // Chip is off-screen when progress < spec.delay and fully
    // assembled by progress = 1. Clamp so late chips wait their turn.
    const t = Math.min(1, Math.max(0, (progress.value - spec.delay) / (1 - spec.delay)));
    const x = interpolate(t, [0, 1], [spec.startX, spec.endX]);
    const y = interpolate(t, [0, 1], [spec.startY, spec.endY]);
    const rot = interpolate(t, [0, 1], [spec.rotStart, 0]);
    // Chips fade to zero once they're in place so the wordmark can
    // shine through cleanly.
    const opacity = interpolate(t, [0, 0.75, 1], [0, 1, 0.55]);
    const scale = interpolate(t, [0, 0.6, 1], [0.6, 1.05, 1]);
    return {
      transform: [{ translateX: x }, { translateY: y }, { rotate: `${rot}deg` }, { scale }],
      opacity,
      width: spec.chipW,
      height: spec.chipH,
    };
  });
  return <Animated.View style={[styles.chip, style, { backgroundColor: color }]} />;
}

/** Wordmark that fades in as the chips lock into position. */
function ResolvedLogo({
  progress,
  height,
}: {
  progress: Animated.SharedValue<number>;
  height: number;
}) {
  const style = useAnimatedStyle(() => {
    // Only reveal once chips are ~85% assembled.
    const opacity = interpolate(progress.value, [0.75, 1], [0, 1], "clamp");
    const scale = interpolate(progress.value, [0.75, 1], [0.92, 1], "clamp");
    return { opacity, transform: [{ scale }] };
  });
  return (
    <Animated.View style={[styles.logoLayer, style]} pointerEvents="none">
      <Image
        source={BRAND.logo}
        style={{ width: height * 0.9, height: height * 0.9 }}
        resizeMode="contain"
        accessibilityLabel="TRADE AI powered by FOURBUY"
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#0B1220",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  chipsLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  chip: {
    position: "absolute",
    borderRadius: 2,
    // Cyan drop-shadow gives the chips a "circuitboard" feel without
    // needing a heavy blur pass.
    shadowColor: "#22D3EE",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 4,
  },
  logoLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
});
