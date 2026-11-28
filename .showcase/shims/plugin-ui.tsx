// Minimal stand-ins for the host's Settings kit: the same labels, hints and layout, so a settings
// capture reads like the real screen.
import { createElement } from "react";
import { View, Text, Pressable } from "react-native";

/**
 * The real Icon renders inline SVG. The showcase is web-only, so it hands the SVG string to the
 * browser and paints the mark exactly as the app does, including a mono glyph tinted white.
 */
export function Icon(props: any) {
  if (!props || !props.icon || !props.icon.svg) return null;
  const svg = String(props.icon.svg).replace("<svg ", '<svg width="' + props.size + '" height="' + props.size + '" ');
  return createElement("span", {
    style: { display: "flex", width: props.size, height: props.size, color: props.color || undefined },
    dangerouslySetInnerHTML: { __html: svg },
  });
}
export function Loading() { return createElement(Text, null, "Loading…"); }

export function SettingsSection(props: any) {
  return createElement(
    View,
    { style: { paddingHorizontal: 16, paddingTop: 8, gap: 10 } },
    createElement(Text, { style: { color: "#f2f3f5", fontSize: 15, fontWeight: "600" } }, props.title),
    props.info ? createElement(Text, { style: { color: "#a3a6ad", fontSize: 11 } }, props.info) : null,
    props.children,
  );
}

export function SettingsRow(props: any) {
  return createElement(
    View,
    { style: { paddingVertical: 8, gap: 2, borderTopWidth: 1, borderTopColor: "#2a2a30" } },
    createElement(Text, { style: { color: "#f2f3f5", fontSize: 12 } }, props.label),
    props.hint ? createElement(Text, { style: { color: "#a3a6ad", fontSize: 10 } }, props.hint) : null,
    props.children,
  );
}

export function SettingsInput(props: any) {
  return createElement(
    View,
    { style: { paddingVertical: 8, gap: 2, borderTopWidth: 1, borderTopColor: "#2a2a30" } },
    createElement(Text, { style: { color: "#f2f3f5", fontSize: 12 } }, props.label),
    props.hint ? createElement(Text, { style: { color: "#a3a6ad", fontSize: 10 } }, props.hint) : null,
    createElement(
      View,
      { style: { marginTop: 4, padding: 6, borderRadius: 6, backgroundColor: "#1f1f23" } },
      createElement(Text, { style: { color: props.initialValue ? "#f2f3f5" : "#6b6e77", fontSize: 11 } },
        props.initialValue || props.placeholder || ""),
    ),
  );
}

export function SettingsAction(props: any) {
  return createElement(
    View,
    { style: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#2a2a30" } },
    createElement(Text, { style: { color: "#f2f3f5", fontSize: 12 } }, props.label),
  );
}

export function SettingsSwitch(props: any) {
  return createElement(
    View,
    { style: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#2a2a30", gap: 2 } },
    createElement(Text, { style: { color: "#f2f3f5", fontSize: 12 } }, props.label),
    props.hint ? createElement(Text, { style: { color: "#a3a6ad", fontSize: 10 } }, props.hint) : null,
    createElement(Text, { style: { color: props.value ? "#7aa2f7" : "#6b6e77", fontSize: 10 } }, props.value ? "on" : "off"),
  );
}
