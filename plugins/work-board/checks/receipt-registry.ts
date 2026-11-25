import { readFileSync } from "node:fs";
import os from "node:os";
import { isAbsolute, join } from "node:path";
import { errorMessage } from "../shared/errors";
import { z } from "zod";
import { validatorIdSchema } from "../shared/check-receipt";

const registrations = z.record(validatorIdSchema, z.object({
  argv: z.array(z.string().min(1).max(1000)).min(1).max(32),
  cwd: z.string().refine(isAbsolute, "Validator directory must be absolute"),
}).strict());

export function registeredValidator(id: string) {
  const path = join(os.homedir(), ".bb", "work-board-receipt-validators.json");
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`No receipt validators are registered: ${path} is missing`);
    throw new Error(`Cannot read receipt validator registry ${path}: ${errorMessage(error)}`, { cause: error });
  }

  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`Invalid JSON in receipt validator registry ${path}; expected a UTF-8 JSON object`, { cause: error });
  }
  const registry = registrations.safeParse(data);
  if (!registry.success)
    throw new Error(`Invalid receipt validator registry ${path}: ${registry.error.message}`);
  if (!Object.hasOwn(registry.data, id)) throw new Error(`Unknown host-registered receipt validator: ${id}`);
  return registry.data[id];
}
