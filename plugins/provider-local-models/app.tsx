import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { SplashSettings } from "./settings.tsx";

export default definePluginApp(app => {
  app.slots.settingsSection({ id: "splash", title: "Status and models", description: "Server health, Splash drafts and model context on the BB server machine.", component: SplashSettings });
});
