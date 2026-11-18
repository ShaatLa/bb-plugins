import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import type { ControlStatus } from './splash-controls.ts';
import type { DoctorReport } from './requirements.ts';
const model = z.object({ model: z.string().min(1).max(500).refine(id => !/[\r\n\[\]]/.test(id)) }).strict();
const ok = z.object({ ok: z.literal(true) });
export const settingsRpcContract = defineRpcContract({
  splashStatus: { input: z.null(), output: z.custom<ControlStatus>() },
  splashDownload: { input: model, output: ok },
  splashCancel: { input: model, output: ok },
  splashDelete: { input: model, output: ok },
  splashRestart: { input: model, output: ok },
  setContext: { input: model.extend({ tokens: z.number().int().positive().nullable() }).strict(), output: z.object({ warning: z.string().nullable(), restartAvailable: z.boolean() }) },
  doctor: { input: z.object({ force: z.boolean() }).nullable(), output: z.custom<DoctorReport>() },
  installSplash: { input: z.object({ command: z.enum(['brew install incoai/tap/splash', 'brew upgrade incoai/tap/splash']), confirmed: z.literal(true) }).strict(), output: ok },
});
