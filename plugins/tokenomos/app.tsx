import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TokenomosPage } from "./components/page";
import { TokenomosSettings } from "./components/settings";
import { LimitsFooter } from "./components/limits-footer";

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "tokenomos", title: "Tokenomos", icon: "tokenomos/mark", path: "tokenomos", component: TokenomosPage });
  app.slots.settingsSection({ id: "tokenomos-settings", title: "Tokenomos", component: TokenomosSettings });
  app.experimental_sidebarFooter.register({ kind: "disclosure", id: "limits", label: "Tokenomos: limits forecast", icon: "tokenomos/mark", component: LimitsFooter });
});
