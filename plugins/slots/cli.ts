import { cliCommand, defineCli, type BbPluginApi, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { setTimeout as sleep } from "node:timers/promises";
import type { Invoke } from "./server.js";
import type { Result, SettingsFormView, ObserverView, RpcMethods, RequestOutcome, StatusView, GateOutcome, HostSettings, Lease, AuditEvent, ReleaseOutcome, SlotRequest } from "./contract.js";
import { plural } from "./lib/plural.js";
import { parseSince } from "./runtime.js";

const line = (text: string) => text.replace(/\s+/g, " ").slice(0, 200);
const leaseLine = (lease: Lease) => `${lease.id} ${lease.pool} #${lease.slotIndex} · ${lease.holderThreadId} · ${line(lease.job)} · expires ${new Date(lease.expiresAt).toISOString()}`;
function humanOutput(method: string, data: unknown): string {
  switch (method) {
    case "config": return Object.entries((data as SettingsFormView).values).map(([key, value]) => `${key} = ${value}`).join("\n");
    case "observer": {
      const view = data as ObserverView;
      return `Observer ${view.threadId ? `${view.threadId} · ${line(view.title ?? view.threadId)}` : "none"} · events: ${view.events.join(", ") || "none"}`;
    }
    case "gate": {
      const { passed, gate, thresholds } = data as GateOutcome & { thresholds: Record<string, HostSettings> };
      const settings = Object.values(thresholds ?? {})[0];
      const reading = gate.latest;
      return `${passed ? "PASS" : "FAIL"} ${reading ? `memory free ${reading.memFreePct.toFixed(1)}% (min ${settings.memFreeMinPct}%) · load ${reading.load1.toFixed(1)} (max ${settings.loadMax}) · streak ${gate.streak}/${settings.gateSamples} · sampled ${new Date(reading.at).toISOString().slice(11)}` : "no readings"}`;
    }
    case "request": {
      const outcome = data as RequestOutcome;
      return outcome.kind === "leased" ? `Granted ${leaseLine(outcome.lease)}` :
        `Queued ${outcome.request.id} · ${outcome.request.pool} · ${outcome.request.priority} · ${line(outcome.request.job)} · estimate ${Math.ceil(outcome.request.estMs / 60000)}m`;
    }
    case "status": {
      const view = data as StatusView;
      return [...(view.settingsWarnings ?? []).map(message => `Warning: ${message}`), ...view.pools.flatMap(p => [
        `${p.pool} · ${p.leases.length}/${plural(p.capacity, "slot")} held · ${p.queue.length} queued`,
        ...p.leases.map(l => `  ${leaseLine(l)} · ${line(view.titles[l.holderThreadId] ?? l.holderThreadId)}`),
        ...p.queue.map(r => `  queued ${r.id} · ${r.priority} · ${line(view.titles[r.threadId] ?? r.threadId)} · ${line(r.job)}`),
      ])].join("\n");
    }
    case "log": {
      const { events } = data as { events: AuditEvent[] };
      return events.length ? events.map(e => [new Date(e.at).toISOString(), e.type, e.pool, e.requestId, e.leaseId,
        e.threadId, e.port, e.readings ? `memory ${e.readings.memFreePct.toFixed(1)}% · load ${e.readings.load1.toFixed(1)}` : undefined,
        e.reason ? line(e.reason) : undefined].filter(v => v !== undefined).join(" · ")).join("\n") : "No events.";
    }
    case "release": case "revoke": {
      const result = data as ReleaseOutcome;
      return `Released ${result.released.join(", ") || "none"} · returned ${result.returned.join(", ") || "none"} · canceled ${result.canceled.join(", ") || "none"}`;
    }
    case "heartbeat": return `Heartbeat refreshed ${(data as { leases: Lease[] }).leases.map(l => l.id).join(", ") || "no leases"}`;
    case "transfer": case "grant": return leaseLine(data as Lease);
    case "port": return `Port ${(data as { port: number }).port}`;
    case "prioritize": return `${(data as SlotRequest).id} priority ${(data as SlotRequest).priority}`;
    case "setCapacity": return `Capacity ${plural((data as { capacity: number }).capacity, "slot")}`;
    default: return "Done.";
  }
}
export function renderResult(method: string, result: Result<unknown>, json: boolean): PluginCliResult {
  const gate = result.ok && method === "gate" ? result.data as { passed: boolean } : null;
  return { exitCode: !result.ok || gate?.passed === false ? 1 : 0,
    stdout: json ? JSON.stringify(result) : result.ok ? humanOutput(method, result.data) : result.error.message };
}
export function registerCli(bb: BbPluginApi, invoke: Invoke) {
  const json = { type: "boolean", description: "Return bounded JSON" } as const;
  const thread = { type: "string", description: "Caller thread (defaults to BB_THREAD_ID)" } as const;
  const pool = { type: "enum", values: ["heavy", "local-model"], description: "Resource pool", required: true } as const;
  const priority = { type: "enum", values: ["normal", "high", "urgent"], description: "Queue priority" } as const;
  const id = (name: string, required = true) => [{ name, description: `${name} identifier`, required }] as const;
  async function call(method: keyof RpcMethods, params: Record<string, unknown>, ctx: PluginCliContext, needsThread = true) {
    if (needsThread && !params.threadId) params.threadId = ctx.threadId;
    if (["request", "gate", "port", "setCapacity"].includes(method)) params.hostId = (await bb.sdk.system.config()).primaryHostId;
    return invoke(method, params);
  }
  const simple = (method: keyof RpcMethods, summary: string, needsThread = true) => cliCommand({ summary,
    options: { json, thread }, async run(input, ctx) {
      const params = needsThread ? { threadId: input.options.thread } : {};
      const result = await call(method, params, ctx, needsThread);
      if (method === "gate" && result.ok) {
        const status = await invoke("status", {});
        if (status.ok) Object.assign(result.data as object, { thresholds: (status.data as StatusView).hostSettings });
      }
      return renderResult(method, result, !!input.options.json);
    },
  });
  bb.cli.register(defineCli({ name: "slots", summary: "Advisory local resource leases and machine gate", commands: {
    config: cliCommand({ summary: "Show, set or unset Machine Slots configuration", options: { json }, positionals: [
      { name: "operation", description: "show, set or unset", required: false },
      { name: "key", description: "Setting name", required: false },
      { name: "value", description: "New value", required: false },
    ], async run(i) { return renderResult("config", await invoke("config", { operation: i.positionals.operation ?? "show", ...(i.positionals.key ? { key: i.positionals.key } : {}), ...(i.positionals.value !== undefined ? { value: i.positionals.value } : {}) }), !!i.options.json); } }),
    observer: cliCommand({ summary: "Show or change the observer and event filter", options: {
      json, thread: { type: "string", description: "New observer thread ID" },
      self: { type: "boolean", description: "Make the calling thread the observer" },
      clear: { type: "boolean", description: "Clear the observer" },
      events: { type: "string", description: "Comma-separated observer event names (empty disables)" },
    }, async run(i, c) {
      return renderResult("observer", await invoke("observer", { ...(i.options.self ? { self: true, threadId: c.threadId } : {}),
        ...(i.options.thread !== undefined ? { toThreadId: i.options.thread } : {}), ...(i.options.clear ? { clear: true } : {}),
        ...(i.options.events !== undefined ? { events: i.options.events } : {}) }), !!i.options.json);
    } }),
    request: cliCommand({ summary: "Queue heavy work; optionally wait for a grant", options: {
      json, thread, pool, job: { type: "string", required: true, description: "Job description (max 2000 characters)" },
      est: { type: "duration", defaultUnit: "m", required: true, description: "Estimated duration (35m)" }, priority,
      wait: { type: "boolean", description: "Wait for a grant; disconnect withdraws the request" },
      timeout: { type: "duration", defaultUnit: "m", description: "Wait deadline (default 30m, maximum 60m)" },
    }, async run(input, ctx) {
      const o = input.options;
      const timeout = o.timeout ?? 1800000;
      if (timeout <= 0 || timeout > 3600000) return renderResult("request", { ok: false, error: { code: "invalid-input", message: "timeout must be positive and at most 60m" } }, !!o.json);
      const caller = o.thread ?? ctx.threadId;
      let result = await call("request", { threadId: caller, pool: o.pool, job: o.job, estMs: o.est, ...(o.priority ? { priority: o.priority } : {}) }, ctx);
      if (!result.ok || !o.wait || (result.data as RequestOutcome).kind !== "queued") return renderResult("request", result, !!o.json);
      const requestId = ((result.data as RequestOutcome) as Extract<RequestOutcome, {kind: "queued"}>).request.id;
      const deadline = Date.now() + timeout;
      try {
        while (Date.now() < deadline) {
          await sleep(Math.min(3000, deadline - Date.now()), undefined, { signal: ctx.signal });
          result = await invoke("status", {});
          if (!result.ok) break;
          const view = result.data as StatusView;
          const lease = view.pools.flatMap(p => p.leases).find(l => l.requestId === requestId);
          if (lease) return renderResult("request", { ok: true, data: { kind: "leased", lease } }, !!o.json);
          if (!view.pools.some(p => p.queue.some(r => r.id === requestId))) throw new Error("Request was canceled");
        }
        if (!result.ok) return renderResult("request", result, !!o.json);
        const current = await invoke("status", {});
        if (!current.ok) return renderResult("request", current, !!o.json);
        const view = current.data as StatusView;
        const lease = view.pools.flatMap(p => p.leases).find(l => l.requestId === requestId);
        if (lease) return renderResult("request", { ok: true, data: { kind: "leased", lease } }, !!o.json);
        const queue = view.pools.find(p => p.queue.some(r => r.id === requestId))?.queue;
        if (!queue) return renderResult("request", { ok: false, error: { code: "not-found", message: "canceled" } }, !!o.json);
        const message = `still queued at position ${queue.findIndex(r => r.id === requestId) + 1} (${requestId}); run the same command again to keep waiting`;
        return { exitCode: 75, stdout: o.json ? JSON.stringify({ ok: false, error: { code: "timeout", message } }) : message };
      } catch (error) {
        if (!ctx.signal?.aborted) return renderResult("request", { ok: false, error: { code: "not-found", message: String(error) } }, !!o.json);
        const withdrawn = await invoke("release", { threadId: caller, leaseId: requestId });
        if (!withdrawn.ok) {
          const current = await invoke("status", {});
          const lease = current.ok ? (current.data as StatusView).pools.flatMap(p => p.leases).find(l => l.requestId === requestId) : undefined;
          if (lease) await invoke("release", { threadId: caller, leaseId: lease.id });
        }
        return renderResult("request", { ok: false, error: { code: "not-found", message: String(error) } }, !!o.json);
      }
    } }),
    release: cliCommand({ summary: "Release leases or cancel queued requests", options: { json, thread }, positionals: id("id", false),
      async run(i, c) { return renderResult("release", await call("release", { threadId: i.options.thread, ...(i.positionals.id ? { leaseId: i.positionals.id } : {}) }, c), !!i.options.json); } }),
    heartbeat: simple("heartbeat", "Extend held leases"), gate: simple("gate", "Take a fresh machine sample; exit 1 on failure"),
    status: simple("status", "Show pools, queue, gate and effective settings", false),
    transfer: cliCommand({ summary: "Transfer a lease to a QA child", options: { json, thread, to: { type: "string", required: true, description: "Child thread ID" }, lease: { type: "string", description: "Lease ID (required if ambiguous)" } },
      async run(i,c) { return renderResult("transfer", await call("transfer", { threadId: i.options.thread, toThreadId: i.options.to, ...(i.options.lease ? { leaseId: i.options.lease } : {}) }, c), !!i.options.json); } }),
    port: simple("port", "Lease an available loopback port for a held lease"),
    prioritize: cliCommand({ summary: "Change queue priority (manager)", options: { json, priority: { ...priority, required: true } }, positionals: id("request"),
      async run(i,c) { return renderResult("prioritize", await call("prioritize", { requestId: i.positionals.request, priority: i.options.priority },c,false), !!i.options.json); } }),
    revoke: cliCommand({ summary: "Revoke a lease with a reason (manager)", options: { json, reason: { type: "string", required: true, description: "Reason sent to the holder" } }, positionals: id("lease"),
      async run(i,c) { return renderResult("revoke", await call("revoke", { leaseId: i.positionals.lease, reason: i.options.reason },c,false), !!i.options.json); } }),
    grant: cliCommand({ summary: "Grant out of queue order; still checks capacity and gate", options: { json }, positionals: id("request"),
      async run(i,c) { return renderResult("grant", await call("grant", { requestId: i.positionals.request },c,false), !!i.options.json); } }),
    capacity: cliCommand({ summary: "Persist pool capacity without revoking live leases", options: { json, pool }, positionals: [{ name: "count", description: "Nonnegative capacity", required: true }],
      async run(i,c) { return renderResult("setCapacity", await call("setCapacity", { pool: i.options.pool, capacity: Number(i.positionals.count) },c,false), !!i.options.json); } }),
    log: cliCommand({ summary: "Read audit JSONL (retained 14 days)", options: { json, since: { type: "string", description: "Duration (2h) or ISO UTC time" }, limit: { type: "integer", min: 1, max: 1000, description: "Maximum events (1–1000, default 100)" } },
      async run(i,c) { return renderResult("log", await call("log", { ...(i.options.since ? { since: parseSince(i.options.since, Date.now()) } : {}), ...(i.options.limit !== undefined ? { limit: i.options.limit } : {}) },c,false), !!i.options.json); } }),
  } }));
}
