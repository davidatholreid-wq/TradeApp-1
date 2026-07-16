import { useContext } from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BottomTabBarHeightContext } = require("@react-navigation/bottom-tabs");

/**
 * Bottom-tab-bar height that safely returns 0 when the caller is rendered
 * OUTSIDE a Tabs navigator (e.g. inside the wide-screen admin cockpit).
 */
export function useSafeTabBarHeight(): number {
  const height = useContext(BottomTabBarHeightContext as any);
  return typeof height === "number" ? height : 0;
}
