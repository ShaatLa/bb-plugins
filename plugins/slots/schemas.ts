import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { SETTING_KEYS, LOCAL_MODEL_MAX, OBSERVER_EVENTS, type ObserverEvent, type RpcMethods, type State } from "./contract.js";
const id = z.string().trim().min(1).max(200);
const pool = z.enum(["heavy", "local-model"]);
const priority = z.enum(["normal", "high", "urgent"]);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const thread = { threadId: id };
const host = { hostId: id };
const device = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, "Device name: 1–32 letters, digits, '.', '_' or '-'");
export const observerEventsSchema = z.string().refine(value => value.trim() === "" || value.split(",").every(name => OBSERVER_EVENTS.includes(name.trim() as ObserverEvent)), "Unknown observer event");
/** `host_id=capacity[,host_id=capacity]`: other bb machines that may lease heavy work. */
export const remoteHostsSchema = z.string().max(4000).refine(value => {
  const ids = value.split(",").map(e => e.trim()).filter(Boolean).map(e => /^([A-Za-z0-9_-]{1,200})=(\d{1,4})$/.exec(e)?.[1]);
  return ids.every(Boolean) && new Set(ids).size === ids.length;
}, "Use host_id=capacity, comma-separated, each host once (e.g. host_example=4)");
/** `host_id=load limit`: same form as remoteHosts, each limit positive. */
export const remoteLoadSchema = remoteHostsSchema.refine(value => value.split(",").map(e => e.trim()).filter(Boolean).every(e => Number(e.split("=")[1]) > 0), "Each load limit must be positive");
export const parseRemoteHosts = (value: string): [string, number][] => value.split(",").map(e => e.trim()).filter(Boolean).map(e => { const [h, n] = e.split("="); return [h, Number(n)]; });
export const deviceHostsSchema = z.string().max(4000).refine(value => {
  const entries = value.split(",").map(e => e.trim()).filter(Boolean);
  const names = entries.map(e => /^([A-Za-z0-9][A-Za-z0-9._-]{0,31})=[A-Za-z0-9_-]{1,200}$/.exec(e)?.[1]);
  return names.every(Boolean) && new Set(names).size === names.length && !names.includes("local");
}, "Use device=host_id, comma-separated, each device once");
export const parseDeviceHosts = (value: string): Record<string, string> => Object.fromEntries(value.split(",").map(e => e.trim()).filter(Boolean).map(e => e.split("=")));
export const machineToolsSchema = z.string().max(4000).refine(value => {
  const entries = value.split(";").map(e => e.trim()).filter(Boolean);
  const ids = entries.map(e => /^([A-Za-z0-9_-]{1,200})=(?:[a-z0-9-]+(?:,[a-z0-9-]+)*)?$/.exec(e)?.[1]);
  return ids.every(Boolean) && new Set(ids).size === ids.length;
}, "Use host_id=tool,tool; host_other=tool with lowercase tool names");
export const parseMachineTools = (value: string): Record<string, string[]> => Object.fromEntries(value.split(";").map(e => e.trim()).filter(Boolean).map(e => { const [host, tools] = e.split("="); return [host, tools ? tools.split(",") : []]; }));
const needs = z.array(z.string().regex(/^[a-z0-9-]+$/).max(64)).max(64);
export const parseObserverEvents = (value: string): ObserverEvent[] => [...new Set(observerEventsSchema.parse(value).split(",").map(name => name.trim()).filter(Boolean))] as ObserverEvent[];
export const inputs = {
  settingsRead: z.object({}).strict(),
  settingsWrite: z.object({ values: z.partialRecord(z.enum(SETTING_KEYS), z.union([z.number(), z.string()])).optional(), unset: z.array(z.enum(SETTING_KEYS)).optional() }).strict(),
  config: z.object({ operation: z.enum(["show", "get", "set", "unset"]).default("show"), key: z.enum(SETTING_KEYS).optional(), value: z.union([z.number(), z.string()]).optional() }).strict(),
  observer: z.object({ threadId: id.optional(), self: z.boolean().optional(), toThreadId: id.optional(), clear: z.boolean().optional(), events: observerEventsSchema.optional() }).strict().refine(p => Number(!!p.self) + Number(!!p.toThreadId) + Number(!!p.clear) <= 1 && (!p.self || !!p.threadId), "Choose self, target thread or clear; self requires a caller"),
  request: z.object({ ...thread, ...host, pool, job: z.string().trim().min(1).max(2000), estMs: time.positive(), priority: priority.optional(), device: device.optional(), wait: z.literal(false).optional(), timeoutMs: time.optional() }).strict(),
  acquire: z.object({ ...thread, ...host, pool, job: z.string().trim().min(1).max(2000), estMs: time.positive(), priority: priority.optional(), device: device.optional(), spill: z.boolean().optional(), place: z.enum(["auto", "local", "project"]).optional(), needs: needs.optional() }).strict(),
  done: z.object({ ...thread, useId: id }).strict(),
  detach: z.object({ ...thread, useId: id }).strict(),
  heartbeatUse: z.object({ ...thread, useId: id }).strict(),
  release: z.object({ ...thread, leaseId: id.optional(), all: z.boolean().optional() }).strict(),
  heartbeat: z.object(thread).strict(), gate: z.object({ ...thread, ...host }).strict(),
  status: z.object({ hostId: id.optional() }).strict(),
  transfer: z.object({ ...thread, toThreadId: id, leaseId: id.optional() }).strict(),
  port: z.object({ ...thread, ...host, probe: z.boolean().optional() }).strict(),
  prioritize: z.object({ requestId: id, priority }).strict(),
  revoke: z.object({ leaseId: id, reason: z.string().trim().min(1).max(2000) }).strict(),
  grant: z.object({ requestId: id }).strict(),
  setCapacity: z.object({ ...host, pool, capacity: z.number().int().min(0).max(10000), withModel: z.boolean().optional() }).strict().refine(p => p.pool !== "local-model" || p.capacity <= LOCAL_MODEL_MAX, { message: `Local model capacity cannot exceed ${LOCAL_MODEL_MAX}`, path: ["capacity"] }),
  log: z.object({ since: time.optional(), hostId: id.optional(), limit: z.number().int().min(1).max(1000).optional() }).strict(),
  devices: z.object({ hostId: id.optional(), devices: z.array(z.object({ name: device, capacity: z.number().int().min(0).max(100).default(1) }).strict()).max(32).optional() }).strict(),
};
// The engine produces typed JSON results; input schemas are the trust boundary.
function method<K extends keyof RpcMethods>(key: K) {
  return { input: inputs[key], output: z.custom<RpcMethods[K]["output"]>() };
}
export const rpcContract = defineRpcContract({
  "config.get": { input: z.object({ projectId: id, key: z.literal("placement").optional() }).strict(), output: z.object({ placement: z.enum(["auto", "local"]) }) },
  "config.set": { input: z.object({ projectId: id, key: z.literal("placement"), value: z.enum(["auto", "local"]) }).strict(), output: z.object({ placement: z.enum(["auto", "local"]) }) },
  config: method("config"), settingsRead: method("settingsRead"), settingsWrite: method("settingsWrite"),
  observer: method("observer"), request: method("request"), acquire: method("acquire"), done: method("done"), detach: method("detach"), heartbeatUse: method("heartbeatUse"), release: method("release"), heartbeat: method("heartbeat"),
  gate: method("gate"), status: method("status"), transfer: method("transfer"), port: method("port"),
  prioritize: method("prioritize"), revoke: method("revoke"), grant: method("grant"), setCapacity: method("setCapacity"), log: method("log"), devices: method("devices"),
});
const use = z.object({ id, threadId: id, startedAt: time, expiresAt: time });
const useFields = { uses: z.array(use).default([]), autoRelease: z.boolean().default(false), graceUntil: time.nullable().default(null) };
const request = inputs.request.omit({ wait: true, timeoutMs: true }).extend({ id, createdAt: time, priority, queueWaitAlerted: z.boolean().default(false), spill: z.boolean().optional(), place: z.enum(["auto", "local"]).optional(), needs: needs.optional(), ...useFields });
const lease = z.object({ id, requestId: id, hostId: id, pool, slotIndex: time, ownerThreadId: id, holderThreadId: id,
  job: z.string(), estMs: time.positive(), grantedAt: time, lastHeartbeatAt: time, expiresAt: time, warnedAt: time.nullable(), device: device.optional(), homeHostId: id.optional(), idle: z.object({ since: time.nullable(), alerted: z.boolean() }).optional(), holdingSince: time.optional(), ...useFields });
const readings = z.object({ memFreePct: z.number().min(0).max(100), load1: z.number().nonnegative(), at: time, passed: z.boolean() });
export const stateSchema: z.ZodType<State> = z.object({ version: z.literal(1), nextId: time.positive(), nextAuditSeq: time.positive(),
  hosts: z.record(id, z.object({ watch: z.object({ lastEndAt: time.nullable(), settings: z.string(), heavyEndAt: z.record(id, time), subjects: z.record(z.string().min(1), z.object({ threadIds: z.array(id), ancestorThreadIds: z.array(id).optional(), intervals: z.array(z.object({ startAt: time, endAt: time, cores: z.number().nonnegative() })), episode: z.boolean(), lastAlertAt: time.nullable(), seenAt: time })) }).optional(), gate: z.object({ latest: readings.nullable(), streak: time, awayStreak: time.default(0), lastCountedAt: time.nullable(), failingSince: time.nullable().default(null), holdAlerted: z.boolean().default(false) }), devices: z.array(z.object({ name: device, capacity: time })).optional() })),
  requests: z.array(request), leases: z.array(lease), ports: z.array(z.object({ hostId: id, threadId: id, port: time.min(1).max(65535), createdAt: time })),
  audit: z.array(z.object({ seq: time, at: time, type: z.enum(["request", "grant", "release", "expire", "warn", "revoke", "use-expired", "use-dropped", "unclaimed", "transfer", "gate", "prioritize", "capacity", "port", "port-release", "queue-wait", "gate-hold", "observer", "unleased-load", "idle-lease"]), hostId: id.optional(), pool: pool.optional(), device: device.optional(), threadId: id.optional(), requestId: id.optional(), leaseId: id.optional(), port: time.optional(), readings: readings.omit({ passed: true }).optional(), reason: z.string().optional(), manual: z.boolean().optional() })),
});
