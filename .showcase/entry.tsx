/**
 * Offline capture harness. It mounts the real Usage and Settings screens against a snapshot
 * produced by the real aggregator, so a screenshot shows the interface a user gets rather than a
 * drawing of it.
 *
 * The host modules (`@getpaseo/plugin/client*`, react-query) are stubbed from `shims/`, and
 * react-native runs as react-native-web. Nothing here ships: it exists to produce the registry
 * image and to eyeball a layout change without launching the app.
 */
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { View, Text } from "react-native";
import { UsageScreen, UsageSettingsScreen } from "../client/usage-screen";
import { mockBrands, mockAccounts, mockCredentials, mockSettings, mockSnapshot } from "./mock";

(globalThis as any).__MOCK_SNAPSHOT__ = mockSnapshot;
(globalThis as any).__MOCK_BRANDS__ = mockBrands;
(globalThis as any).__MOCK_ACCOUNTS__ = mockAccounts;
(globalThis as any).__MOCK_CREDENTIALS__ = mockCredentials;
(globalThis as any).__MOCK_SETTINGS__ = mockSettings;
// The settings sections fetch through their own query keys; the shim reads the answers here.
(globalThis as any).__MOCK_QUERY__ = {
  accounts: mockAccounts,
  credentials: mockCredentials,
  brands: mockBrands,
};

/** Paseo's dark surface ramp, so the capture matches what the app draws. */
const dark = {
  surface0: "#0d0d0f",
  surface1: "#161618",
  surface2: "#1f1f22",
  border: "#2c2c31",
  foreground: "#f2f3f5",
  foregroundMuted: "#a1a4ab",
  accent: "#7aa2f7",
  accentForeground: "#0d0d0f",
  statusSuccess: "#4ade80",
  statusWarning: "#fbbf24",
  statusDanger: "#f87171",
};

const light = {
  surface0: "#f6f6f7",
  surface1: "#ffffff",
  surface2: "#f1f2f3",
  border: "#dcdde1",
  foreground: "#16171a",
  foregroundMuted: "#5d6167",
  accent: "#2563eb",
  accentForeground: "#ffffff",
  statusSuccess: "#15803d",
  statusWarning: "#b45309",
  statusDanger: "#b91c1c",
};

type Colors = typeof dark;

const themeOf = (colors: Colors, isDark: boolean) => ({ name: isDark ? "dark" : "light", dark: isDark, colors });
const layout = { compact: false, platform: "web" as const, width: 1440, height: 2400 };

/** Which surface the capture shows. `?screen=settings` switches to the settings page. */
const screen = new URLSearchParams(globalThis.location?.search ?? "").get("screen") ?? "usage";
/** `?theme=light` renders the light ramp, which is what the registry also accepts. */
const isDark = new URLSearchParams(globalThis.location?.search ?? "").get("theme") !== "light";
const colors = isDark ? dark : light;

/**
 * Opens the first card after the first paint, so the capture shows the projection chart and the
 * per-model split as well as the collapsed grid. Paseo opens a card on a press; this is that press.
 */
function useOpenFirstCard() {
  useEffect(() => {
    let attempts = 0;
    const tick = () => {
      const card = document.querySelector('button[aria-label*="spent this cycle"]');
      if (card instanceof HTMLElement) {
        // react-native-web's Pressable answers to the pointer sequence, not to a bare click, so
        // the harness sends the same three events a finger would.
        const box = card.getBoundingClientRect();
        const at = { clientX: box.left + 40, clientY: box.top + 20, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, isPrimary: true };
        card.focus?.();
        card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        card.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        card.dispatchEvent(new PointerEvent("pointerdown", at));
        card.dispatchEvent(new PointerEvent("pointerup", { ...at, buttons: 0 }));
        card.dispatchEvent(new MouseEvent("click", at));
        return;
      }
      if (++attempts < 60) setTimeout(tick, 25);
    };
    setTimeout(tick, 400);
  }, []);
}

function Usage() {
  useOpenFirstCard();
  return <UsageScreen theme={themeOf(colors, isDark)} layout={layout} host={{ id: "host-1" } as any} />;
}

function Settings() {
  return <UsageSettingsScreen theme={themeOf(colors, isDark)} layout={layout} />;
}

function App() {
  return (
    <View style={{ width: 1440, backgroundColor: colors.surface0 }}>
      {/* A small title bar, because a screenshot of a screen with no header reads as a stray
          fragment rather than as a page. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 20,
          paddingVertical: 14,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600" as const }}>
          {screen === "settings" ? "Settings · Tallimeter" : "Usage"}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Tallimeter</Text>
      </View>
      {screen === "settings" ? <Settings /> : <Usage />}
    </View>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
