import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { SETTING_KEYS, OBSERVER_EVENTS, type ObserverEvent, type RpcMethods, type State } from "./contract.js";
const id = z.string().trim().min(1).max(200);
const pool = z.enum(["heavy", "local-model"]);
const priority = z.enum(["normal", "high", "urgent"]);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const thread = { threadId: id };
const host = { hostId: id };
export const observerEventsSchema = z.string().refine(value => value.trim() === "" || value.split(",").every(name => OBSERVER_EVENTS.includes(name.trim() as ObserverEvent)), "Unknown observer event");
export const parseObserverEvents = (value: string): ObserverEvent[] => [...new Set(observerEventsSchema.parse(value).split(",").map(name => name.trim()).filter(Boolean))] as ObserverEvent[];
export const inputs = {
  settingsRead: z.object({}).strict(),
  settingsWrite: z.object({ values: z.partialRecord(z.enum(SETTING_KEYS), z.union([z.number(), z.string()])).optional(), unset: z.array(z.enum(SETTING_KEYS)).optional() }).strict(),
  config: z.object({ operation: z.enum(["show", "set", "unset"]).default("show"), key: z.enum(SETTING_KEYS).optional(), value: z.union([z.number(), z.string()]).optional() }).strict(),
  observer: z.object({ threadId: id.optional(), self: z.boolean().optional(), toThreadId: id.optional(), clear: z.boolean().optional(), events: observerEventsSchema.optional() }).strict().refine(p => Number(!!p.self) + Number(!!p.toThreadId) + Number(!!p.clear) <= 1 && (!p.self || !!p.threadId), "Choose self, target thread or clear; self requires a caller"),
  request: z.object({ ...thread, ...host, pool, job: z.string().trim().min(1).max(2000), estMs: time.positive(), priority: priority.optional(), wait: z.literal(false).optional(), timeoutMs: time.optional() }).strict(),
  release: z.object({ ...thread, leaseId: id.optional() }).strict(),
  heartbeat: z.object(thread).strict(), gate: z.object({ ...thread, ...host }).strict(),
  status: z.object({ hostId: id.optional() }).strict(),
  transfer: z.object({ ...thread, toThreadId: id, leaseId: id.optional() }).strict(),
  port: z.object({ ...thread, ...host, probe: z.boolean().optional() }).strict(),
  prioritize: z.object({ requestId: id, priority }).strict(),
  revoke: z.object({ leaseId: id, reason: z.string().trim().min(1).max(2000) }).strict(),
  grant: z.object({ requestId: id }).strict(),
  setCapacity: z.object({ ...host, pool, capacity: z.number().int().min(0).max(10000) }).strict(),
  log: z.object({ since: time.optional(), hostId: id.optional(), limit: z.number().int().min(1).max(1000).optional() }).strict(),
};
// The engine produces typed JSON results; input schemas are the trust boundary.
function method<K extends keyof RpcMethods>(key: K) {
  return { input: inputs[key], output: z.custom<RpcMethods[K]["output"]>() };
}
export const rpcContract = defineRpcContract({
  config: method("config"), settingsRead: method("settingsRead"), settingsWrite: method("settingsWrite"),
  observer: method("observer"), request: method("request"), release: method("release"), heartbeat: method("heartbeat"),
  gate: method("gate"), status: method("status"), transfer: method("transfer"), port: method("port"),
  prioritize: method("prioritize"), revoke: method("revoke"), grant: method("grant"), setCapacity: method("setCapacity"), log: method("log"),
});
const request = inputs.request.omit({ wait: true, timeoutMs: true }).extend({ id, createdAt: time, priority, queueWaitAlerted: z.boolean().default(false) });
const lease = z.object({ id, requestId: id, hostId: id, pool, slotIndex: time, ownerThreadId: id, holderThreadId: id,
  job: z.string(), estMs: time.positive(), grantedAt: time, lastHeartbeatAt: time, expiresAt: time, warnedAt: time.nullable() });
const readings = z.object({ memFreePct: z.number().min(0).max(100), load1: z.number().nonnegative(), at: time, passed: z.boolean() });
export const stateSchema: z.ZodType<State> = z.object({ version: z.literal(1), nextId: time.positive(), nextAuditSeq: time.positive(),
  hosts: z.record(id, z.object({ gate: z.object({ latest: readings.nullable(), streak: time, lastCountedAt: time.nullable(), failingSince: time.nullable().default(null), holdAlerted: z.boolean().default(false) }) })),
  requests: z.array(request), leases: z.array(lease), ports: z.array(z.object({ hostId: id, threadId: id, port: time.min(1).max(65535), createdAt: time })),
  audit: z.array(z.object({ seq: time, at: time, type: z.enum(["request", "grant", "release", "expire", "warn", "revoke", "transfer", "gate", "prioritize", "capacity", "port", "port-release", "queue-wait", "gate-hold", "observer"]), hostId: id.optional(), pool: pool.optional(), threadId: id.optional(), requestId: id.optional(), leaseId: id.optional(), port: time.optional(), readings: readings.omit({ passed: true }).optional(), reason: z.string().optional(), manual: z.boolean().optional() })),
});
