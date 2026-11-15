import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TokenomosPage } from "./components/page";
import { TokenomosSettings } from "./components/settings";

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "tokenomos", title: "Tokenomos", icon: "ChartColumn", path: "tokenomos", component: TokenomosPage });
  app.slots.settingsSection({ id: "tokenomos-settings", title: "Tokenomos", component: TokenomosSettings });
});
