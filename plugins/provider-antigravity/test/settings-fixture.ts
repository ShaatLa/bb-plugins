import type { Diagnostics } from "../settings-contract.ts";
export const diagnosticsFixture: Diagnostics = {
  observedAt: "2026-10-23T12:00:00Z",
  installation: { executableName: "agy", executablePath: "/test/agy", installed: true, installSource: "external", currentVersion: "1.4.6", latestVersion: null,
    minimumSupportedVersion: "1.4.6", npmPackageName: null, npmGlobalPackageVersion: null, needsUpdate: false, versionUnsupported: false, installAction: null },
  usage: { status: "ok", accountEmail: "fixture@example.test", planLabel: null, windows: [{ label: "5h", usedPercent: 25, resetsAt: "2026-10-24T00:00:00Z" }] },
  credits: { status: "ok", remainingCredits: 0, message: null },
  nativeSettings: { filePath: "/test/settings.json", useG1Credits: false, revision: "a".repeat(64), editable: true, message: null },
  models: [{ id: "gemini-4-argon", displayName: "Gemini 4 Argon", efforts: ["low", "medium", "high"] }], modelsMessage: null,
};
