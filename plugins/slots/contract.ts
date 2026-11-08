export const SLOTS_CHANGED = "slots.changed";

/** Wire and persistence contract. All times and durations are milliseconds. */
export const POOLS = ["heavy", "local-model"] as const;
export type PoolName = (typeof POOLS)[number];
export type Priority = "urgent" | "high" | "normal";
export const OBSERVER_EVENTS = ["warn", "expire", "revoke", "queue-wait", "gate-hold", "grant", "release", "transfer", "capacity", "unleased-load", "idle-lease"] as const;
export type ObserverEvent = (typeof OBSERVER_EVENTS)[number];
export interface HostSettings {
  watchPolicy: "off" | "warn"; watchCores: number; watchWindowSeconds: number; idleLeaseMinutes: number;
  capacities: Record<PoolName, number>;
  memFreeMinPct: number;
  loadMax: number;
  gateSamples: number;
  gateIntervalMs: number;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  observerThreadId: string | null;
  observerEvents: ObserverEvent[];
  observerQueueWaitMs: number;
  observerGateHoldMs: number;
  portRange: { from: number; to: number };
  grantMode: "auto" | "manual";
}
export interface Settings extends HostSettings {
  /** Complete host overrides; omitted hosts use the top-level defaults. */
  hosts: Record<string, HostSettings>;
}
export const DEFAULT_SETTINGS: Settings = {
  watchPolicy: "warn", watchCores: 3, watchWindowSeconds: 120, idleLeaseMinutes: 30,
  capacities: { heavy: 4, "local-model": 1 },
  memFreeMinPct: 20, loadMax: 18, gateSamples: 2, gateIntervalMs: 15_000,
  leaseTtlMs: 1_800_000, heartbeatIntervalMs: 600_000,
  observerEvents: ["warn", "expire", "revoke", "queue-wait", "gate-hold", "unleased-load", "idle-lease"],
  observerQueueWaitMs: 1_200_000, observerGateHoldMs: 900_000,
  observerThreadId: null, portRange: { from: 41000, to: 41099 },
  grantMode: "auto", hosts: {},
};
export interface Use { id: string; threadId: string; startedAt: number; expiresAt: number }
export interface SlotRequest {
  id: string; hostId: string; pool: PoolName; threadId: string;
  job: string; estMs: number; priority: Priority; createdAt: number;
  queueWaitAlerted?: boolean; uses?: Use[]; autoRelease?: boolean; graceUntil?: number | null;
}
export type QueueEntry = SlotRequest;
export interface Lease {
  id: string; requestId: string; hostId: string; pool: PoolName; slotIndex: number;
  ownerThreadId: string; holderThreadId: string; job: string; estMs: number;
  grantedAt: number; lastHeartbeatAt: number; expiresAt: number; warnedAt: number | null;
  idle?: { since: number | null; alerted: boolean }; holdingSince?: number;
  uses?: Use[]; autoRelease?: boolean; graceUntil?: number | null;
}
export interface GateReadings { memFreePct: number; load1: number; at: number }
export interface GateState {
  latest: (GateReadings & { passed: boolean }) | null;
  streak: number; lastCountedAt: number | null;
  failingSince?: number | null; holdAlerted?: boolean;
}
export interface PortLease { hostId: string; threadId: string; port: number; createdAt: number }
export type AuditType = "request" | "grant" | "release" | "expire" | "warn" | "revoke" |
  "use-expired" | "use-dropped" | "unclaimed" | "transfer" | "gate" | "prioritize" | "capacity" | "port" | "port-release" | "queue-wait" | "gate-hold" | "observer" | "unleased-load" | "idle-lease";
export interface AuditEvent {
  seq: number; at: number; type: AuditType; hostId?: string; pool?: PoolName;
  threadId?: string; requestId?: string; leaseId?: string; port?: number;
  readings?: GateReadings; reason?: string; manual?: boolean;
}
export interface UsageSubject { key: string; threadIds: string[]; ancestorThreadIds?: string[]; cores: number }
export interface WatchState {
  lastEndAt: number | null; settings: string; heavyEndAt: Record<string, number>;
  subjects: Record<string, { threadIds: string[]; ancestorThreadIds?: string[]; intervals: { startAt: number; endAt: number; cores: number }[]; episode: boolean; lastAlertAt: number | null; seenAt: number }>;
}
export interface WatchRunStats { at: number; durationMs: number; cpuMs: number; psMs: number; lsofMs: number; lsofCalls: number }
export interface WatchDiagnostics { last: WatchRunStats | null; average10m: Omit<WatchRunStats, "at"> & { runs: number } }
export interface HostState {
  watch?: WatchState;
  gate: GateState;
}
export interface State {
  version: 1; nextId: number; nextAuditSeq: number;
  hosts: Record<string, HostState>;
  requests: SlotRequest[]; leases: Lease[]; ports: PortLease[]; audit: AuditEvent[];
}
export interface PoolSnapshot {
  hostId: string; pool: PoolName; capacity: number; leases: Lease[]; queue: QueueEntry[];
}
export interface StatusSnapshot {
  at: number; pools: PoolSnapshot[];
  gates: Record<string, GateState>; ports: PortLease[]; audit: AuditEvent[];
}
/** What the `status` RPC returns: the engine snapshot plus server-resolved display data. */
export interface StatusView extends StatusSnapshot {
  /** Thread id -> title for every holder, owner and requester in the snapshot. */
  watcher?: WatchDiagnostics;
  titles: Record<string, string>;
  /** Effective settings per host in the snapshot (thresholds for the UI). */
  hostSettings: Record<string, HostSettings>;
  /** The BB server host id; the only host whose gate is sampled in v1. */
  localHostId: string;
  /** Display name from the SDK; null when unavailable. */
  localHostName?: string | null;
  settingsWarnings?: string[];
}
export interface SlotsError {
  code: "invalid-input" | "not-found" | "forbidden" | "capacity" | "gate-closed" | "port-in-use" | "transferred" | "in-use";
  message: string; readings?: GateReadings;
}
export type Result<T> = { ok: true; data: T } | { ok: false; error: SlotsError };
export interface RequestParams {
  hostId: string; pool: PoolName; threadId: string; job: string; estMs: number; priority?: Priority;
  /** Waiting is implemented by the server, never by the reducer. */
  wait?: boolean; timeoutMs?: number;
}
export type UseOutcome = ({ kind: "queued"; request: SlotRequest; useId: string } | { kind: "leased"; lease: Lease; useId: string });
export type RequestOutcome = { kind: "queued"; request: SlotRequest } | { kind: "leased"; lease: Lease };
export interface ReleaseParams { threadId: string; leaseId?: string }
export interface ReleaseOutcome { released: string[]; returned: string[]; canceled: string[] }
export interface HeartbeatParams { threadId: string }
export interface HeartbeatOutcome { leases: Lease[] }
export interface GateParams { hostId: string; threadId: string }
export interface GateOutcome { passed: boolean; open: boolean; gate: GateState }
export interface StatusParams { hostId?: string }
export interface TransferParams { threadId: string; leaseId?: string; toThreadId: string }
export interface PortParams { hostId: string; threadId: string; probe?: boolean }
export interface PrioritizeParams { requestId: string; priority: Priority }
export interface RevokeParams { leaseId: string; reason: string }
export interface GrantParams { requestId: string }
export interface SetCapacityParams { hostId: string; pool: PoolName; capacity: number }
export interface LogParams { since?: number; hostId?: string; limit?: number }
/** Server implements these methods with boundary validation; these types have no SDK dependency. */
export interface ObserverParams { threadId?: string; self?: boolean; toThreadId?: string; clear?: boolean; events?: string }
export interface ObserverView { threadId: string | null; title: string | null; events: ObserverEvent[] }
export const SETTING_KEYS = ["heavyCapacity", "localModelCapacity", "memFreeMinPct", "loadMax", "gateSamples", "gateIntervalSeconds", "leaseTtlMinutes", "heartbeatIntervalMinutes", "observerThreadId", "observerEvents", "observerQueueWaitMinutes", "observerGateHoldMinutes", "portFrom", "portTo", "grantMode", "watchPolicy", "watchCores", "watchWindowSeconds", "idleLeaseMinutes"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type SettingValues = Record<SettingKey, number | string>;
export interface SettingsFormView { values: SettingValues; defaults: SettingValues; maxima: Partial<Record<SettingKey, number>>; setKeys: SettingKey[]; cores: number; heavyDefault: number }
export interface RpcMethods {
  settingsRead: { input: Record<string, never>; output: Result<SettingsFormView> };
  config: { input: { operation?: "show" | "set" | "unset"; key?: SettingKey; value?: number | string }; output: Result<SettingsFormView> };
  settingsWrite: { input: { values?: Partial<SettingValues>; unset?: SettingKey[] }; output: Result<SettingsFormView> };
  observer: { input: ObserverParams; output: Result<ObserverView> };
  request: { input: RequestParams; output: Result<RequestOutcome> };
  acquire: { input: RequestParams; output: Result<UseOutcome> };
  done: { input: { threadId: string; useId: string }; output: Result<null> };
  detach: { input: { threadId: string; useId: string }; output: Result<UseOutcome | { kind: "queued"; position: number }> };
  heartbeatUse: { input: { threadId: string; useId: string }; output: Result<UseOutcome> };
  release: { input: ReleaseParams; output: Result<ReleaseOutcome> };
  heartbeat: { input: HeartbeatParams; output: Result<HeartbeatOutcome> };
  gate: { input: GateParams; output: Result<GateOutcome> };
  status: { input: StatusParams; output: Result<StatusView> };
  transfer: { input: TransferParams; output: Result<Lease> };
  port: { input: PortParams; output: Result<PortLease> };
  prioritize: { input: PrioritizeParams; output: Result<SlotRequest> };
  revoke: { input: RevokeParams; output: Result<ReleaseOutcome> };
  grant: { input: GrantParams; output: Result<Lease> };
  setCapacity: { input: SetCapacityParams; output: Result<{ capacity: number }> };
  log: { input: LogParams; output: Result<{ events: AuditEvent[] }> };
}
export type RpcRequest<K extends keyof RpcMethods> = RpcMethods[K]["input"];
export type RpcResponse<K extends keyof RpcMethods> = RpcMethods[K]["output"];
export type Input =
  | { type: "usage"; hostId: string; startAt: number; endAt: number; valid: boolean; unknownCores: number; subjects: UsageSubject[]; resetKeys?: string[] }
  | { type: "request"; hostId: string; pool: PoolName; threadId: string; job: string; estMs: number; priority?: Priority }
  | ({ type: "acquire" } & Omit<RequestParams, "wait" | "timeoutMs">)
  | { type: "done" | "detach" | "heartbeatUse"; threadId: string; useId: string }
  | ({ type: "release" } & ReleaseParams)
  | ({ type: "heartbeat" } & HeartbeatParams)
  | ({ type: "gate" } & GateParams)
  | ({ type: "gateSample"; hostId: string } & GateReadings)
  | ({ type: "transfer"; isChild: boolean } & TransferParams)
  | { type: "portLease"; hostId: string; threadId: string; port: number }
  | ({ type: "prioritize" } & PrioritizeParams)
  | ({ type: "revoke" } & RevokeParams)
  | ({ type: "grant" } & GrantParams)
  | ({ type: "setCapacity" } & SetCapacityParams)
  | { type: "threadEnded"; threadId: string; reason: "archived" | "deleted" }
  | { type: "observer" | "unleased-load" | "idle-lease"; hostId: string; previousThreadId: string | null; previousEvents: ObserverEvent[]; previousEnded?: boolean; title: string | null }
  | { type: "tick" } | { type: "restored" };
export type NotificationMessage = { title: string; lines: { label?: string; value: string }[]; hint?: string };
export type Effect = ({ type: "notify"; threadId: string; reason: AuditType; watch?: { hostId: string; subject: UsageSubject; holderThreadId?: string } } & NotificationMessage) |
  { type: "audit"; event: AuditEvent };
export type EngineOutput = UseOutcome | { kind: "queued"; position: number } | RequestOutcome | ReleaseOutcome | HeartbeatOutcome | GateOutcome |
  Lease | PortLease | SlotRequest | { capacity: number } | null;
export interface Context { now: number; settings: Settings }
export interface Transition { state: State; effects: Effect[]; result: Result<EngineOutput> }
