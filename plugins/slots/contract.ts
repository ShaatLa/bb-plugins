export const SLOTS_CHANGED = "slots.changed";

/** Wire and persistence contract. All times and durations are milliseconds. */
export const POOLS = ["heavy", "local-model"] as const;
export type PoolName = (typeof POOLS)[number];
export type Priority = "urgent" | "high" | "normal";
export const OBSERVER_EVENTS = ["warn", "expire", "revoke", "queue-wait", "gate-hold", "grant", "release", "transfer", "capacity"] as const;
export type ObserverEvent = (typeof OBSERVER_EVENTS)[number];
export interface HostSettings {
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
  capacities: { heavy: 4, "local-model": 1 },
  memFreeMinPct: 20, loadMax: 18, gateSamples: 2, gateIntervalMs: 15_000,
  leaseTtlMs: 1_800_000, heartbeatIntervalMs: 600_000,
  observerEvents: ["warn", "expire", "revoke", "queue-wait", "gate-hold"],
  observerQueueWaitMs: 1_200_000, observerGateHoldMs: 900_000,
  observerThreadId: null, portRange: { from: 41000, to: 41099 },
  grantMode: "auto", hosts: {},
};
export interface SlotRequest {
  id: string; hostId: string; pool: PoolName; threadId: string;
  job: string; estMs: number; priority: Priority; createdAt: number;
  queueWaitAlerted?: boolean;
}
export type QueueEntry = SlotRequest;
export interface Lease {
  id: string; requestId: string; hostId: string; pool: PoolName; slotIndex: number;
  ownerThreadId: string; holderThreadId: string; job: string; estMs: number;
  grantedAt: number; lastHeartbeatAt: number; expiresAt: number; warnedAt: number | null;
}
export interface GateReadings { memFreePct: number; load1: number; at: number }
export interface GateState {
  latest: (GateReadings & { passed: boolean }) | null;
  streak: number; lastCountedAt: number | null;
  failingSince?: number | null; holdAlerted?: boolean;
}
export interface PortLease { hostId: string; threadId: string; port: number; createdAt: number }
export type AuditType = "request" | "grant" | "release" | "expire" | "warn" | "revoke" |
  "transfer" | "gate" | "prioritize" | "capacity" | "port" | "port-release" | "queue-wait" | "gate-hold" | "observer";
export interface AuditEvent {
  seq: number; at: number; type: AuditType; hostId?: string; pool?: PoolName;
  threadId?: string; requestId?: string; leaseId?: string; port?: number;
  readings?: GateReadings; reason?: string; manual?: boolean;
}
export interface HostState {
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
  titles: Record<string, string>;
  /** Effective settings per host in the snapshot (thresholds for the UI). */
  hostSettings: Record<string, HostSettings>;
  /** The BB server host id; the only host whose gate is sampled in v1. */
  localHostId: string;
  /** Display name from the SDK; null when unavailable. */
  localHostName?: string | null;
  /** Effective values equal their machine-derived defaults. */
  loadMaxAuto?: boolean;
  heavyCapacityAuto?: boolean;
  settingsWarnings?: string[];
}
export interface SlotsError {
  code: "invalid-input" | "not-found" | "forbidden" | "capacity" | "gate-closed" | "port-in-use";
  message: string; readings?: GateReadings;
}
export type Result<T> = { ok: true; data: T } | { ok: false; error: SlotsError };
export interface RequestParams {
  hostId: string; pool: PoolName; threadId: string; job: string; estMs: number; priority?: Priority;
  /** Waiting is implemented by the server, never by the reducer. */
  wait?: boolean; timeoutMs?: number;
}
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
export interface RpcMethods {
  observer: { input: ObserverParams; output: Result<ObserverView> };
  request: { input: RequestParams; output: Result<RequestOutcome> };
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
  | { type: "request"; hostId: string; pool: PoolName; threadId: string; job: string; estMs: number; priority?: Priority }
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
  | { type: "observer"; hostId: string; previousThreadId: string | null; previousEvents: ObserverEvent[]; previousEnded?: boolean; title: string | null }
  | { type: "tick" } | { type: "restored" };
export type Effect = { type: "notify"; threadId: string; text: string; reason: AuditType } |
  { type: "audit"; event: AuditEvent };
export type EngineOutput = RequestOutcome | ReleaseOutcome | HeartbeatOutcome | GateOutcome |
  Lease | PortLease | SlotRequest | { capacity: number } | null;
export interface Context { now: number; settings: Settings }
export interface Transition { state: State; effects: Effect[]; result: Result<EngineOutput> }
