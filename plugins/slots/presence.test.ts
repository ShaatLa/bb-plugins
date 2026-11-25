import { describe, expect, it } from "vitest";
import { decidePresence, parseAssertions, parseDisplay, parseIdle, type RawPresence } from "./presence.js";

// `pmset -g assertions` layout from real captures; pids, ids and uuids are placeholders.
const pmset = (...lines: string[]) => `2026-01-01 12:00:00 +0000
Assertion status system-wide:
   PreventUserIdleDisplaySleep    0
   PreventUserIdleSystemSleep     1
Listed by owning process:
${lines.join("\n")}
Kernel Assertions: 0x4=USB
   id=1  level=255 0x4=USB creat=01/01/2026, 00:00 description=com.apple.usb.example owner=Example
`;
const line = (process: string, type: string, name: string) => `   pid 100(${process}): [0x0000000000000001] 00:00:05 ${type} named: "${name}"  `;
const SYSTEM = [
  line("powerd", "PreventUserIdleSystemSleep", "Powerd - Prevent sleep while display is on"),
  line("powerd", "InternalPreventDisplaySleep", "com.apple.powermanagement.delayDisplayOff"),
  line("bluetoothd", "PreventUserIdleSystemSleep", "com.apple.BTStack"),
  line("sharingd", "PreventUserIdleSystemSleep", "Handoff"),
  line("useractivityd", "PreventUserIdleSystemSleep", "BTLEAdvertisement.00000000-0000-0000-0000-000000000000"),
  line("runningboardd", "PreventUserIdleSystemSleep", "anon<Example>(501)100-200-300:com.apple.CFNetwork.StorageDB"),
  "\tCreated for PID: 200. ",
  line("apsd", "NoIdleSleepAssertion", "com.apple.apsd-keepalive-push.apple.com-NonCellular"),
  line("AddressBookSourceSync", "PreventUserIdleSystemSleep", "Address Book Source Sync"),
  line("WindowServer", "UserIsActive", "com.apple.iohideventsystem.queue.tickle serviceID:1 eventType:17"),
  "\tTimeout will fire in 430 secs Action=TimeoutActionRelease",
];
const AUDIO_OUT = [line("coreaudiod", "PreventUserIdleSystemSleep", "com.apple.audio.BuiltInSpeakerDevice.context.preventuseridlesleep"), "\tResources: audio-out BuiltInSpeakerDevice "];
const AUDIO_IN = [line("coreaudiod", "PreventUserIdleSystemSleep", "com.apple.audio.AudioTap-00000000-0000-0000-0000-000000000000.context.preventuseridlesleep"), "\tResources: audio-in 00000000-0000-0000-0000-000000000000 "];
const CHROME_VIDEO = line("Google Chrome", "NoDisplaySleepAssertion", "Video Wake Lock");
const CHROME_AUDIO = line("Google Chrome", "NoIdleSleepAssertion", "Playing audio");
const HEADLESS = [line("chrome-headless-shell", "NoDisplaySleepAssertion", "Capturing"), line("Google Chrome for Testing", "NoDisplaySleepAssertion", "Capturing")];

describe("presence probes", () => {
  it("reads input idle time and the display state, null when unparsable", () => {
    expect(parseIdle(`  |   "HIDIdleTime" = 470210845375\n`)).toBeCloseTo(470.21, 2);
    expect(parseIdle("ioreg: no match")).toBeNull();
    expect([parseDisplay("1\n"), parseDisplay("0\n"), parseDisplay("-1\n"), parseDisplay("")]).toEqual([true, false, null, null]);
  });
  it("counts audio from any app, Chrome video with or without sound, and unknown display holders", () => {
    expect(parseAssertions(pmset(...SYSTEM))).toEqual([]); // system holders seen while idle never count
    expect(parseAssertions(pmset(...SYSTEM, ...AUDIO_OUT))).toEqual(["audio"]); // music, or Chrome with sound
    expect(parseAssertions(pmset(...AUDIO_IN, ...AUDIO_OUT))).toEqual(["audio"]); // display-off playback, even at zero volume
    expect(parseAssertions(pmset(...SYSTEM, ...AUDIO_OUT, CHROME_VIDEO, CHROME_AUDIO))).toEqual(["audio", "Google Chrome"]);
    expect(parseAssertions(pmset(...SYSTEM, CHROME_VIDEO))).toEqual(["Google Chrome"]); // muted video: only "Video Wake Lock"
    expect(parseAssertions(pmset(...SYSTEM, ...HEADLESS))).toEqual([]); // agents' headless renders
    expect(parseAssertions(pmset(line("chrome-headless-shell", "NoDisplaySleepAssertion", "Video Wake Lock")))).toEqual(["chrome-headless-shell"]); // exact pair only
    expect(parseAssertions(pmset(line("Example Player", "PreventUserIdleDisplaySleep", "Playback")))).toEqual(["Example Player"]); // fail-safe
  });
  it("treats unparsable assertions as a failed probe", () => {
    expect(parseAssertions("pmset: error")).toBeNull();
    expect(parseAssertions(pmset("   pid 100(Example) something unexpected"))).toBeNull();
  });
  it("reads a complete output without a process section as no holders", () => {
    const idle = `2026-01-01 12:00:00 +0000
Assertion status system-wide:
   PreventUserIdleDisplaySleep    0
   PreventUserIdleSystemSleep     0
Kernel Assertions: 0x0
`;
    expect(parseAssertions(idle)).toEqual([]);
    expect(parseAssertions(idle.replace("PreventUserIdleDisplaySleep    0", "PreventUserIdleDisplaySleep    1"))).toBeNull(); // active status row, no process section
    expect(parseAssertions(idle.replace("PreventUserIdleDisplaySleep    0", "PreventUserIdleDisplaySleep    ?"))).toBeNull(); // unparsable status row
    expect(parseAssertions(idle.split("Kernel Assertions:")[0])).toBeNull(); // cut before Kernel Assertions
    expect(parseAssertions("2026-01-01 12:00:00 +0000\n   PreventUserIdleSystemSleep     0\n")).toBeNull(); // neither header
  });
  it("treats truncated assertions as a failed probe, not as no media", () => {
    const head = pmset().split("Kernel Assertions:")[0];
    expect(parseAssertions(head)).toBeNull(); // cut right after the header
    expect(parseAssertions(head.replace("Listed by owning process:\n", "Listed by owning process:"))).toBeNull();
    expect(parseAssertions(`${head}${SYSTEM.join("\n")}\n`)).toBeNull(); // cut mid-list
    expect(parseAssertions(`${head}${AUDIO_OUT[0]}`)).toBeNull(); // cut mid-list, media never reached
  });
});

describe("presence decision", () => {
  const raw = (overrides: Partial<RawPresence> = {}): RawPresence => ({ idleSeconds: 0, displayAsleep: false, media: [], memFreePct: 50, load1: 1, cores: 8, ...overrides });
  it("is away after the threshold without input, or with the display asleep, and no media", () => {
    expect(decidePresence(raw({ idleSeconds: 600 }), 10)).toEqual({ away: true, idleMinutes: 10, media: [], reason: "no input 10 min" });
    expect(decidePresence(raw({ idleSeconds: 599 }), 10)).toMatchObject({ away: false, reason: "input 9 min ago" });
    expect(decidePresence(raw({ idleSeconds: 30, displayAsleep: true }), 10)).toMatchObject({ away: true, reason: "display asleep" });
  });
  it("media keeps the owner present, display on or off", () => {
    expect(decidePresence(raw({ idleSeconds: 3600, displayAsleep: true, media: ["audio"] }), 10)).toMatchObject({ away: false, media: ["audio"], reason: "media playing (audio)" });
  });
  it("fails closed when any probe failed", () => {
    for (const failed of [null, raw({ idleSeconds: null, displayAsleep: true }), raw({ idleSeconds: 3600, displayAsleep: null }), raw({ idleSeconds: 3600, media: null })])
      expect(decidePresence(failed, 10)).toMatchObject({ away: false, reason: "presence unknown (probe failed)" });
  });
});
