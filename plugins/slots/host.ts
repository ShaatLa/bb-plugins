import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { availableParallelism, cpus } from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { metrics } from "./runtime.js";
import { parseAssertions, parseDisplay, parseIdle, presenceHostContract } from "./presence.js";

const run = async (file: string, args: string[]) => (await promisify(execFile)(file, args, { timeout: 4000, maxBuffer: 1 << 20 })).stdout;
const DISPLAY = 'ObjC.import("CoreGraphics"); $.CGDisplayIsAsleep($.CGMainDisplayID())';

/** Runs on every bb machine: presence and machine-check readings in one call; a failed probe returns null. */
export default experimental_defineHostEntry({
  contract: presenceHostContract,
  handlers: {
    async presence() {
      const [idleSeconds, displayAsleep, media, readings] = await Promise.all([
        run("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"]).then(parseIdle, () => null),
        run("/usr/bin/osascript", ["-l", "JavaScript", "-e", DISPLAY]).then(parseDisplay, () => null),
        run("/usr/bin/pmset", ["-g", "assertions"]).then(parseAssertions, () => null),
        metrics().catch(() => null),
      ]);
      return { idleSeconds, displayAsleep, media, memFreePct: readings?.memFreePct ?? null, load1: readings?.load1 ?? null, cores: Math.max(1, availableParallelism?.() ?? cpus().length) };
    },
  },
});
