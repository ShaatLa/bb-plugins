import { installationStatus, readCredits, readUsage } from "./maintenance.ts";
import { readModels } from "./models.ts";
import { readNativeSettings } from "./native-settings.ts";
import type { Diagnostics } from "./settings-contract.ts";

export async function readDiagnostics(command = "", checkUpdates = false): Promise<Diagnostics> {
  const [installation, usage, credits, nativeSettings, catalog] = await Promise.all([
    installationStatus(command, checkUpdates), readUsage(command), readCredits(command), readNativeSettings(),
    readModels(command).then(models => ({ models, message: null })).catch(() => ({ models: [], message: "Google model catalog could not be read." })),
  ]);
  return { observedAt: new Date().toISOString(), installation, usage, credits, nativeSettings,
    models: catalog.models.map(model => ({ id: model.id, displayName: model.displayName, efforts: model.supportedReasoningEfforts.map(effort => effort.reasoningEffort) })),
    modelsMessage: catalog.message };
}
