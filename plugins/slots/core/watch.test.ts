import { expect, it } from "vitest";
import { apply, initialState } from "./index.js";
import { DEFAULT_SETTINGS, type Input, type Lease } from "../contract.js";
import { stateSchema } from "../schemas.js";
function setup() {
  let state = initialState();
  const settings = structuredClone(DEFAULT_SETTINGS); settings.observerThreadId = "observer"; settings.idleLeaseMinutes = 10;
  function send(input: Input, now = "endAt" in input ? input.endAt : 0) {
    const result = apply(state, input, { now, settings }); expect(result.result.ok).toBe(true); state = result.state; return result;
  }
  const usage = (startAt: number, endAt: number, cores = 4, extra: Partial<Extract<Input, { type: "usage" }>> = {}) => send({ type: "usage", hostId: "h", startAt, endAt, cores: undefined, valid: true, unknownCores: 0, subjects: [{ key: "/repo", threadIds: ["a"], cores }], ...extra } as Extract<Input, { type: "usage" }>);
  usage(0, 0);
  return { settings, send, usage, get state() { return state; }, lease(holder = "a") {
    state.leases.push({ id: "lease-1", requestId: "req-1", hostId: "h", pool: "heavy", slotIndex: 0, ownerThreadId: "a", holderThreadId: holder, job: "tests", estMs: 1, grantedAt: 0, lastHeartbeatAt: 0, expiresAt: 99999999, warnedAt: null } satisfies Lease);
  } };
}
const notices = (r: ReturnType<typeof apply>, reason = "unleased-load") => r.effects.filter(e => e.type === "notify" && e.reason === reason);
it("weights unequal durations, clips windows and emits once per high episode", () => {
  const h = setup(); h.usage(0, 30000, 6); expect(notices(h.usage(30000, 120000, 2))).toHaveLength(2);
  expect(notices(h.usage(120000, 150000, 6))).toHaveLength(0);
  expect(h.state.hosts.h.watch!.subjects['/repo'].intervals[0].startAt).toBe(30000);
  h.usage(150000, 270000, 0); expect(h.state.hosts.h.watch!.subjects['/repo'].episode).toBe(false);
  expect(notices(h.usage(270000, 390000, 5))).toHaveLength(0);
  h.usage(390000, 510000, 0);
  for(let t=510000;t<1950000;t+=120000) h.usage(t,t+120000,0);
  expect(notices(h.usage(1950000,2070000,5))).toHaveLength(2);
});
it("alternating 5/2/5/2 core samples fire at average 3.5", () => {
  const h = setup(); h.usage(0,30000,5); h.usage(30000,60000,2); h.usage(60000,90000,5);
  expect(notices(h.usage(90000,120000,2))).toHaveLength(2);
});
it.each([[30000,60000],[10000,50000],[0,150000]])("gaps, overlaps and oversized intervals reset (%s,%s)", (start,end) => {
  const h=setup(); h.usage(0,20000); h.usage(start,end); expect(h.state.hosts.h.watch!.subjects['/repo'].intervals).toEqual([]);
});
it("duplicates and regressions are ignored; invalid samples reset and delayed measured samples work", () => {
  const h=setup(); h.usage(0,60000); const before=structuredClone(h.state); h.usage(0,60000); h.usage(0,30000); expect(h.state).toEqual(before);
  h.usage(60000,90000,4,{valid:false}); expect(h.state.hosts.h.watch!.subjects['/repo'].intervals).toEqual([]);
  expect(notices(h.usage(90000,210000))).toHaveLength(2);
});
it("coverage includes a sibling holder and a lease released wholly between samples", () => {
  const h=setup(); h.lease("b");
  h.usage(0,30000,4,{subjects:[{key:'/repo',threadIds:['a','b'],cores:4}]});
  expect(notices(h.usage(30000,150000,4,{subjects:[{key:'/repo',threadIds:['a','b'],cores:4}]}))).toHaveLength(0);
  h.send({type:'release',threadId:'a'},150001);
  expect(notices(h.usage(150000,270000))).toHaveLength(0);
  expect(notices(h.usage(270000,390000))).toHaveLength(2);
});
it("restart and settings changes reset windows and keep cooldowns; multi-thread groups only notify observer", () => {
  const h=setup(); h.usage(0,120000); const last=h.state.hosts.h.watch!.subjects['/repo'].lastAlertAt;
  h.send({type:'restored'},120001); expect(h.state.hosts.h.watch!.subjects['/repo'].lastAlertAt).toBe(last);
  h.usage(120000,150000); h.settings.watchCores=2; h.usage(150000,180000); expect(h.state.hosts.h.watch!.subjects['/repo'].intervals).toEqual([]);
  h.settings.watchPolicy='off'; expect(notices(h.usage(180000,300000))).toHaveLength(0);
  const m=setup(); m.usage(0,30000,4,{subjects:[{key:'/repo',threadIds:['a','b'],cores:4}]});
  expect(notices(m.usage(30000,150000,4,{subjects:[{key:'/repo',threadIds:['a','b'],cores:4}]}))).toMatchObject([{threadId:'observer'}]);
});
it("bounds short-interval history and restores old state without new fields", () => {
  const h=setup(); for(let t=0;t<120000;t+=1000) h.usage(t,t+1000);
  expect(h.state.hosts.h.watch!.subjects['/repo'].intervals.length).toBeLessThanOrEqual(10);
  expect(stateSchema.parse(initialState())).toEqual(initialState());
});
it("idle uses conservative unknown load, resets on busy/invalid/membership, re-arms and never messages holder", () => {
  const h=setup(); h.lease();
  for(let t=0;t<600000;t+=120000) h.usage(t,t+120000,0.3,{unknownCores:0.3});
  expect(h.state.leases[0].idle?.since).toBeNull();
  let r; for(let t=600000;t<1200000;t+=120000) r=h.usage(t,t+120000,0);
  expect(notices(r!,'idle-lease')).toMatchObject([{threadId:'observer'}]);
  expect(notices(h.usage(1200000,1320000,0),'idle-lease')).toHaveLength(0);
  h.usage(1320000,1440000,1); expect(h.state.leases[0].idle).toEqual({since:null,alerted:false});
  h.usage(1440000,1560000,0,{valid:false}); expect(h.state.leases[0].idle?.since).toBeNull();
  h.usage(1560000,1680000,0); h.usage(1680000,1800000,0,{subjects:[{key:'/repo',threadIds:['a','b'],cores:0}]}); expect(h.state.leases[0].idle?.since).toBeNull();
});
it("cwd changes reset both groups and transfer cannot count the earlier holding period", () => {
  const h=setup(); h.lease(); h.usage(0,120000,0);
  h.usage(120000,240000,0,{resetKeys:['/repo']}); expect(h.state.leases[0].idle?.since).toBeNull();
  h.send({type:'transfer',threadId:'a',toThreadId:'b',isChild:true},240001);
  h.usage(240000,360000,0,{subjects:[{key:'/repo',threadIds:['a','b'],cores:0}]}); expect(h.state.leases[0].idle?.since).toBeNull();
});
it("a grant and release between samples excludes earlier leased CPU and grant resets idle", () => {
  const h=setup(); h.usage(0,60000,5);
  h.send({type:'request',hostId:'h',threadId:'a',pool:'heavy',job:'build',estMs:60000},60001);
  h.send({type:'gateSample',hostId:'h',at:60002,load1:0,memFreePct:90},60002);
  h.send({type:'gateSample',hostId:'h',at:75002,load1:0,memFreePct:90},75002);
  expect(h.state.leases[0].idle).toEqual({since:null,alerted:false});
  h.send({type:'release',threadId:'a'},75003);
  expect(notices(h.usage(60000,180000,5))).toHaveLength(0);
  expect(notices(h.usage(180000,300000,5))).toHaveLength(2);
});
it("idle notices re-arm after activity and use the load of every sibling", () => {
  const h=setup(); h.lease('b');
  const raw=(t:number,cores:number,valid=true)=>h.usage(t,t+120000,cores,{valid,subjects:[{key:'/repo',threadIds:['a','b'],cores}]});
  raw(0,0); let r;
  for(let t=120000;t<720000;t+=120000) r=raw(t,0);
  expect(notices(r!,'idle-lease')).toHaveLength(1);
  raw(720000,0.5); expect(h.state.leases[0].idle).toEqual({since:null,alerted:false});
  for(let t=840000;t<1440000;t+=120000) r=raw(t,0);
  expect(notices(r!,'idle-lease')).toHaveLength(1);
});
it('covers child checkouts and counts their activity for the parent lease', () => {
  const h=setup(); h.settings.idleLeaseMinutes=30; h.lease();
  const subjects=(cores:number)=>[{key:'/repo',threadIds:['a'],cores:0},{key:'/child',threadIds:['child'],ancestorThreadIds:['a'],cores}];
  h.usage(0,120000,0,{subjects:subjects(4)});
  for(let t=120000;t<2040000;t+=120000) expect(notices(h.usage(t,t+120000,0,{subjects:subjects(4)}))).toHaveLength(0);
  expect(h.state.leases[0].idle?.since).toBeNull();
  let r; for(let t=2040000;t<3840000;t+=120000) r=h.usage(t,t+120000,0,{subjects:subjects(0)});
  expect(notices(r!,'idle-lease')).toHaveLength(1);
  const unleased=setup(); unleased.usage(0,120000,0,{subjects:subjects(4)});
  expect(notices(unleased.usage(120000,240000,0,{subjects:subjects(4)}))).toHaveLength(2);
  const old=structuredClone(h.state); delete old.hosts.h.watch!.subjects['/child'].ancestorThreadIds;
  expect(stateSchema.parse(old).hosts.h.watch!.subjects['/child'].ancestorThreadIds).toBeUndefined();
});

it('uses thread storage family activity and the 0.15 core idle threshold', () => {
  const subjects=(cores:number)=>[{key:'/repo',threadIds:['a'],cores:0},{key:'/data/thread-storage/child',threadIds:['child'],ancestorThreadIds:['a'],cores}];
  const uncovered=setup(); uncovered.usage(0,120000,4,{subjects:subjects(4)});
  expect(notices(uncovered.usage(120000,240000,4,{subjects:subjects(4)}))).toHaveLength(2);
  for (const holder of ['a','child']) {
    const h=setup(); h.settings.idleLeaseMinutes=30; h.lease(holder);
    for(let t=0;t<1920000;t+=120000) expect(notices(h.usage(t,t+120000,0.2,{subjects:subjects(0.2)}))).toHaveLength(0);
    expect(h.state.leases[0].idle?.since).toBeNull();
    const alerts=[]; for(let t=1920000;t<3960000;t+=120000) alerts.push(...notices(h.usage(t,t+120000,0.1,{subjects:subjects(0.1)}),'idle-lease'));
    expect(alerts).toHaveLength(1);
  }
});
