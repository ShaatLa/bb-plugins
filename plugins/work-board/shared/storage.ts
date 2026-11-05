import { z } from "zod";

const bytes = z.number().nonnegative();
const count = z.number().int().nonnegative();
export const storageStatusSchema = z.object({
  databaseBytes: bytes, walBytes: bytes, freeDatabaseBytes: bytes,
  blobLogicalBytes: bytes, blobPhysicalBytes: bytes, blobFiles: count,
  orphanFiles: count, orphanBytes: bytes, missingAttachments: count,
  lastCleanedAt: z.string().nullable(),
}).strict();
export const storageResultSchema = z.object({
  before: storageStatusSchema, after: storageStatusSchema,
  removedFiles: count, removedRows: count, deduplicatedFiles: count, warnings: count,
}).strict();
export const storageMethods = {
  getStorageStatus: { input: z.null(), output: storageStatusSchema },
  maintainStorage: { input: z.object({ optimize: z.boolean().default(false) }).strict(), output: storageResultSchema },
};
export type StorageStatus = z.infer<typeof storageStatusSchema>;
export type StorageResult = z.infer<typeof storageResultSchema>;
