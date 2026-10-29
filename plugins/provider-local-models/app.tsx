import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";

// BB loads a plugin's app bundle (and its app.css) only for registered surfaces; an empty overlay keeps the usage styles loaded.
export default definePluginApp(app => {
  app.slots.experimental_appOverlay({ id: "local-models-usage-styles", component: () => null });
});
