import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { SplashSettings } from "./settings.tsx";

export default definePluginApp(app => {
  app.slots.settingsSection({ id: "splash", title: "Splash", description: "Local model requirements, drafts and context on the BB server machine.", component: SplashSettings });
});
