import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { UsageScreen, UsageSettingsScreen } from "./client/usage-screen";

function UsageItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="BarChart3"
      active={currentScreen?.screenId === "usage"}
      onPress={() => openScreen({ screenId: "usage" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "usage", title: "Usage", Component: UsageScreen });
  client.addSidebarHeaderItem({ id: "usage", title: "Usage", Component: UsageItem });

  // One entry point besides the sidebar row, for keyboards and custom sidebar views.
  client.addCommandCenterItem({
    id: "open-usage",
    title: "Usage",
    icon: "BarChart3",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "usage" });
    },
  });

  // Accounts, plans and cycle settings all live here, with every other plugin setting.
  client.addSettingsScreen({
    id: "usage-settings",
    title: "Usage",
    icon: "SlidersHorizontal",
    Component: UsageSettingsScreen,
  });
  return () => {};
}
