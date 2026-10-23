import { defineRpcContract } from "@get-bb/plugin-sdk";
import { providerInstallationStatusSchema, providerUsageSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export const nativeSettingsSchema = z.object({
  filePath: z.string(), useG1Credits: z.boolean().nullable(), revision: z.string().nullable(),
  editable: z.boolean(), message: z.string().nullable(),
});
export const creditsSchema = z.object({
  status: z.enum(["ok", "not_installed", "unauthenticated", "error"]),
  remainingCredits: z.number().nonnegative().nullable(), message: z.string().nullable(),
});
export const diagnosticsSchema = z.object({
  observedAt: z.iso.datetime(), installation: providerInstallationStatusSchema,
  usage: providerUsageSchema, credits: creditsSchema, nativeSettings: nativeSettingsSchema,
  models: z.array(z.object({ id: z.string(), displayName: z.string(), efforts: z.array(z.string()) })),
  modelsMessage: z.string().nullable(),
});
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
export type NativeSettings = z.infer<typeof nativeSettingsSchema>;
const command = z.string().max(4096).default("");
const change = z.object({ enabled: z.boolean(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const settingsHostContract = defineRpcContract({
  diagnostics: { input: z.object({ command, checkUpdates: z.boolean().default(false) }).strict(), output: diagnosticsSchema },
  setCreditUsage: { input: change.extend({ command }), output: nativeSettingsSchema },
});
export const settingsRpcContract = defineRpcContract({
  diagnostics: { input: z.object({ hostId: z.string().min(1), checkUpdates: z.boolean().default(false) }).strict(), output: diagnosticsSchema },
  setCreditUsage: { input: change.extend({ hostId: z.string().min(1) }), output: nativeSettingsSchema },
});
