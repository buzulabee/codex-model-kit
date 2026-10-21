import { z } from "zod";
import { failureContextSchema } from "./diagnostics.js";

export const efforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
const cleanText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v === v.trim() && !/[\x00-\x1f\x7f]/.test(v));
export const modelParametersSchema = z
  .strictObject({
    displayName: cleanText(160),
    requestModel: cleanText(512),
    contextWindow: z.number().int().min(1024).max(10_000_000).nullable(),
    reasoningLevels: z
      .array(z.enum(efforts))
      .max(8)
      .refine((v) => new Set(v).size === v.length),
    defaultReasoning: z.enum(efforts).nullable(),
    images: z.boolean().nullable(),
  })
  .refine(
    (v) =>
      v.defaultReasoning === null ||
      v.reasoningLevels.includes(v.defaultReasoning),
    { message: "默认思考等级必须在支持列表中" },
  );
export type ModelParameters = z.infer<typeof modelParametersSchema>;
export const localModelSchema = z.strictObject({
  key: cleanText(512),
  parameters: modelParametersSchema,
});
export const localCatalogSchema = z.strictObject({
  status: z.enum([
    "not_loaded",
    "not_configured",
    "relative_path",
    "missing",
    "read_error",
    "invalid",
    "ready",
  ]),
  path: z.string().max(1024).nullable(),
  models: z.array(localModelSchema).max(1000),
  failure: failureContextSchema.optional(),
});
export type LocalCatalog = z.infer<typeof localCatalogSchema>;
export const previewRowsSchema = z
  .array(
    z.strictObject({ key: cleanText(512), parameters: modelParametersSchema }),
  )
  .min(1)
  .max(1000);
export const metadataSchema = z.strictObject({
  contextWindow: z.number().int().min(1024).max(10_000_000).optional(),
  reasoningLevels: z.array(z.enum(efforts)).max(8).optional(),
  images: z.boolean().optional(),
});
export type ModelMetadata = z.infer<typeof metadataSchema>;

export const catalogWritePlanSchema = z.strictObject({
  planId: z.string().uuid(),
  expiresAt: z.number().int(),
  action: z.enum(["save", "restore"]),
  path: z.string().max(1024),
  createsFile: z.boolean(),
  removesFile: z.boolean(),
  modelCount: z.number().int().min(0).max(1000),
  added: z.array(z.string().max(512)).max(1000),
  removed: z.array(z.string().max(512)).max(1000),
  changed: z.array(z.string().max(512)).max(1000),
  orderChanged: z.boolean(),
});
export type CatalogWritePlan = z.infer<typeof catalogWritePlanSchema>;
export const catalogWriteReceiptSchema = z.strictObject({
  requestId: z.string().uuid(),
  action: z.enum(["save", "restore"]),
  path: z.string().max(1024),
  backupPath: z.string().max(1200).nullable(),
  savedAt: z.number().int(),
  modelCount: z.number().int().min(0).max(1000),
  durability: z.enum(["synced", "file_synced", "uncertain"]),
});
export type CatalogWriteReceipt = z.infer<typeof catalogWriteReceiptSchema>;
