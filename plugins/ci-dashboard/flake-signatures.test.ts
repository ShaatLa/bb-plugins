import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { classifyJobs } from "./ci-classify";
import { createBackfill, createJobStore, createLogFetcher, fetchAttemptJobs, jobMigrations, type FlakeConfig, type LogScan } from "./ci-jobs";
import type { JobRecord } from "./ci-jobs-types";
import { buildSignals } from "./ci-signals";
import { flakeSettings, flakeSignaturesSchema, parseFlakeRules } from "./flake-signatures";
import { failedTestNames, scanZip as scanEvidence } from "./flake-artifacts";
import { at, failed, failure, fakeGithub, job, runContext, syntheticRun, zip } from "./test-support";

const rules = (text: string) => parseFlakeRules(text).rules;
const SOCKET = "socket hang up => FLAKE-1";
const scanZip = (...args: Parameters<typeof scanEvidence>) => scanEvidence(...args).hit;

describe("parseFlakeRules", () => {
  it("reads rules, ignores blanks and comments, matches case-insensitively", () => {
    const parsed = parseFlakeRules("# known flakes\n\n  socket HANG up   =>   FLAKE-1  \r\ntimeout after \\d+ms => FLAKE-2\n");
    expect(parsed.errors).toEqual([]);
    expect(parsed.rules.map((r) => r.label)).toEqual(["FLAKE-1", "FLAKE-2"]);
    expect(parsed.rules[0]!.pattern.test("a Socket Hang Up")).toBe(true);
  });
  it.each([
    ["a bad regex", "(unclosed => FLAKE-1", /Line 1: invalid regex/],
    ["a missing label", "socket hang up =>", /Line 1: the label is empty/],
    ["a missing separator", "ok => FLAKE-1\nsocket hang up", /Line 2: use "<regex> => <label>"/],
    ["a regex that matches every line", "x* => FLAKE-1", /matches an empty line/],
    ["an empty regex", " => FLAKE-1", /Line 1/],
  ])("rejects %s", (_name, text, message) => {
    expect(parseFlakeRules(text).errors[0]).toMatch(message);
    expect(flakeSignaturesSchema.safeParse(text).success).toBe(false);
  });
  it("limits the rule count and the text length", () => {
    expect(flakeSignaturesSchema.safeParse(Array.from({ length: 50 }, (_, i) => `rule${i} => L${i}`).join("\n")).success).toBe(true);
    expect(flakeSignaturesSchema.safeParse(Array.from({ length: 51 }, (_, i) => `rule${i} => L${i}`).join("\n")).success).toBe(false);
    expect(flakeSignaturesSchema.safeParse(`# ${"x".repeat(4000)}`).success).toBe(false);
    expect(flakeSignaturesSchema.safeParse("").success).toBe(true);
  });
  it("versions the normalized rules and globs; blank rules switch the feature off", () => {
    const base = flakeSettings(SOCKET, "");
    expect(flakeSettings(`# note\n${SOCKET}\n\n`, "").hash).toBe(base.hash);
    expect(flakeSettings(SOCKET, "test-results-*").hash).not.toBe(base.hash);
    expect(flakeSettings("socket hang up => FLAKE-2", "").hash).not.toBe(base.hash);
    expect(flakeSettings("# only a comment", "test-results-*")).toMatchObject({ rules: [], hash: "" });
    expect(flakeSettings(SOCKET, " test-results-* , logs-? ").artifacts.map((re) => re.test("test-results-unit"))).toEqual([true, false]);
  });
});

describe("classifier", () => {
  const h = flakeSettings(SOCKET, "");
  const opts = { flakeRules: h.rules, flakeHash: h.hash };
  const one = (j: JobRecord, extra: Parameters<typeof classifyJobs>[1] = {}) => classifyJobs([j], { ...opts, ...extra })[0]!;
  const signature = (over: Partial<NonNullable<JobRecord["signature"]>> = {}) => ({ rules: h.hash, label: "FLAKE-9", match: "boom", source: "log" as const, ...over });

  it("an annotation hit is a flake with the label and match as evidence", () => {
    expect(one(failed({ annotations: [failure("Error: Socket hang up while waiting")] }))).toMatchObject({ class: "flake", reason: "matches a known flaky signature", evidence: "FLAKE-1: Error: Socket hang up while waiting", flakeLabel: "FLAKE-1" });
  });
  it("a stored signature of the current rules version is a flake; a stale or empty one is ignored", () => {
    expect(one(failed({ signature: signature() }))).toMatchObject({ class: "flake", evidence: "FLAKE-9: boom", flakeLabel: "FLAKE-9" });
    expect(one(failed({ signature: signature({ rules: "old" }) })).class).toBe("real");
    expect(one(failed({ signature: signature({ label: null, match: null, source: null }) })).class).toBe("real");
  });
  it("policy jobs are never flakes, and the same-sha rule still applies after the signature check", () => {
    expect(one(failed({ annotations: [failure("socket hang up")] }), { policyJobs: ["Unit tests"] }).class).toBe("real");
    const pair = classifyJobs([failed({ runId: 1 }), job({ runId: 2 })], opts);
    expect(pair[0]).toMatchObject({ class: "flake", reason: "same job passed at the same sha" });
    expect(pair[0]!.flakeLabel).toBeUndefined();
  });
  it("transient and refusal checks win over a signature", () => {
    expect(one(failed({ annotations: [failure("socket hang up")], logExcerpt: "HTTP 503 Service Unavailable" })).class).toBe("transient");
    expect(one(failed({ annotations: [failure("socket hang up")] }), { refusalSteps: ["Run tests"] }).class).toBe("refused");
  });
});

describe("signal text", () => {
  it("names the matched flake instead of the same-sha pass", () => {
    const j = failed({ jobId: 4, completedAt: at(5) });
    const [signal] = buildSignals({ classified: [{ job: j, class: "flake", reason: "matches a known flaky signature", evidence: "FLAKE-1: socket hang up", flakeLabel: "FLAKE-1" }], reruns: [], massCancels: [], stalls: [], defaultBranch: "main", repository: "acme/widgets", now: Date.parse(at(10)) });
    expect(signal!.what).toBe("Unit tests failed at step Run tests; matches known flake FLAKE-1 (failed run 1)");
  });
});

describe("log scan", () => {
  const stream = (chunks: string[], counters: { reads: number; cancelled: boolean }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: new ReadableStream<Uint8Array>({
      pull(controller) { const chunk = chunks[counters.reads++]; if (chunk === undefined) controller.close(); else controller.enqueue(new TextEncoder().encode(chunk)); }, cancel() { counters.cancelled = true; } }, { highWaterMark: 0 }) }));
  };
  const lead = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("") + "##[error] broken\n";
  const fetcher = () => createLogFetcher("token", new AbortController().signal);

  it("finds a signature after the first ##[error] and leaves the excerpt unchanged", async () => {
    const counters = { reads: 0, cancelled: false };
    stream([lead, "cleanup\n", "2026-11-05T10:00:00Z Error: socket hang up\n", "never read\n"], counters);
    try {
      const scan: LogScan = { rules: rules(SOCKET), hit: null };
      const excerpt = await fetcher()("/logs", scan);
      expect(scan.hit).toEqual({ label: "FLAKE-1", match: "2026-11-05T10:00:00Z Error: socket hang up" });
      expect(excerpt.split("\n")).toHaveLength(30);
      expect(excerpt.endsWith("##[error] broken")).toBe(true);
      expect(counters.reads).toBe(5); // a rule hit alone does not stop the read: a later build failure would override it
      // A build failure line decides the job: the read stops there.
      Object.assign(counters, { reads: 0, cancelled: false }); stream([lead, "FAIL\texample.com/app/db [build failed]\n", "never read\n"], counters);
      const built: LogScan = { rules: rules(SOCKET), hit: null };
      await fetcher()("/logs", built);
      expect(built.build).toBe("FAIL\texample.com/app/db [build failed]");
      expect(counters).toEqual({ reads: 2, cancelled: true });
      // The same log without rules keeps today's early stop.
      Object.assign(counters, { reads: 0, cancelled: false }); stream([lead, "cleanup\n"], counters);
      expect(await fetcher()("/logs")).toBe(excerpt);
      expect(counters.reads).toBe(2); // one more read to see that the line after the error is not another error
    } finally { vi.unstubAllGlobals(); }
  });
  it("also finds a signature before the error and reads the whole log when nothing matches", async () => {
    const counters = { reads: 0, cancelled: false };
    stream(["socket hang up\n", lead, "tail\n"], counters);
    try {
      const scan: LogScan = { rules: rules(SOCKET), hit: null };
      await fetcher()("/logs", scan);
      expect(scan.hit?.label).toBe("FLAKE-1");
      Object.assign(counters, { reads: 0, cancelled: false }); stream(["a\n", lead, "tail"], counters);
      const miss: LogScan = { rules: rules(SOCKET), hit: null };
      expect((await fetcher()("/logs", miss)).endsWith("##[error] broken")).toBe(true);
      expect(miss.hit).toBeNull();
      expect(counters.reads).toBe(4); // three chunks plus the end of the stream
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("zip reader", () => {
  const r = rules(SOCKET);
  it("reads stored and deflated entries", () => {
    expect(scanZip(zip([{ name: "a.txt", data: "all fine\n" }, { name: "b/report.xml", data: "<x>\nsocket hang up\n</x>", deflate: true }]), r)).toEqual({ label: "FLAKE-1", match: "socket hang up" });
    expect(scanZip(zip([{ name: "a.txt", data: "socket hang up" }, { name: "b.txt", data: "x", deflate: true }]), r)?.label).toBe("FLAKE-1");
    expect(scanZip(zip([{ name: "a.txt", data: "nothing here", deflate: true }]), r)).toBeNull();
  });
  it("skips binary entries, entries past the total cap and corrupt archives", () => {
    expect(scanZip(zip([{ name: "dump.bin", data: Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("socket hang up")]) }]), r)).toBeNull();
    expect(scanZip(zip([{ name: "big.txt", data: `${"x".repeat(200)}\nsocket hang up` }]), r, 100)).toBeNull();
    expect(scanZip(zip([{ name: "small.txt", data: "socket hang up" }]), r, 100)?.label).toBe("FLAKE-1");
    const broken = zip([{ name: "a.txt", data: "socket hang up", deflate: true }]);
    broken.fill(0xff, 40, 45);
    expect(scanZip(broken, r)).toBeNull();
    expect(scanZip(Buffer.from("not a zip"), r)).toBeNull();
  });
});

describe("test reports", () => {
  const scan = (data: string, text: string, name = "report.json") => scanZip(zip([{ name, data, deflate: true }]), rules(text));
  const jest = (tests: { fullName: string; status: string; failureMessages?: string[] }[]) => JSON.stringify({ numTotalTests: tests.length, testResults: [{ name: "/src/cart.test.ts", status: "failed", assertionResults: tests.map((t) => ({ failureMessages: [], ...t })) }] });
  const ANSI = "\u001b[31mError: socket reset by peer\u001b[39m\n    at cart.test.ts:1:1";

  it("Jest/Vitest JSON: only failed tests are searched, ANSI is stripped, and a huge single line is fine", () => {
    const report = jest([{ fullName: "cart adds item", status: "passed" }, { fullName: "cart checkout flow", status: "failed", failureMessages: [ANSI] }]);
    expect(scan(report, "adds item => FLAKE-1")).toBeNull();
    expect(scan(report, "checkout flow => FLAKE-1")).toEqual({ label: "FLAKE-1", match: "FAIL /src/cart.test.ts cart checkout flow" });
    expect(scan(report, "socket reset => FLAKE-2")).toEqual({ label: "FLAKE-2", match: "Error: socket reset by peer" });
    const huge = jest([...Array.from({ length: 3000 }, (_, i) => ({ fullName: `cart passes number ${i}`, status: "passed" })), { fullName: "cart last one", status: "failed", failureMessages: ["boom"] }]);
    expect(huge.length).toBeGreaterThan(100_000); expect(huge.includes("\n")).toBe(false);
    expect(scan(huge, "number 17 => FLAKE-1")).toBeNull();
    expect(scan(huge, "last one => FLAKE-1")?.label).toBe("FLAKE-1");
    expect(scan(jest([{ fullName: "cart adds item", status: "passed" }]), "adds item => FLAKE-1")).toBeNull();
  });
  it("sidecar files next to a recognized report are not searched", () => {
    const report = jest([{ fullName: "cart adds item", status: "passed" }, { fullName: "cart checkout flow", status: "failed" }]);
    const manifest = JSON.stringify({ expected_files: ["/src/cart.test.ts", "/src/adds-item.test.ts"] });
    const both = zip([{ name: "manifest.json", data: manifest }, { name: "report.json", data: report, deflate: true }]);
    expect(scanZip(both, rules("adds-item => FLAKE-1"))).toBeNull();
    expect(scanZip(both, rules("checkout flow => FLAKE-1"))?.label).toBe("FLAKE-1");
    expect(scanZip(zip([{ name: "manifest.json", data: manifest }]), rules("adds-item => FLAKE-1"))?.label).toBe("FLAKE-1");
  });
  it("Go test2json: a test whose final action is fail contributes its output; passing tests contribute nothing", () => {
    const event = (Action: string, Test: string, Output?: string) => JSON.stringify({ Action, Package: "acme/pkg", Test, ...(Output === undefined ? {} : { Output }) });
    const report = [event("run", "TestA"), event("output", "TestA", "=== RUN   TestA\n"), event("output", "TestA", "flaky socket noise in a passing test\n"), event("pass", "TestA"),
      event("run", "TestB"), event("output", "TestB", "dial tcp: flaky socket reset\n"), event("fail", "TestB"), JSON.stringify({ Action: "fail", Package: "acme/pkg" })].join("\n");
    expect(scan(report, "TestA => FLAKE-1", "go.jsonl")).toBeNull();
    expect(scan(report, "noise in a passing => FLAKE-1", "go.jsonl")).toBeNull();
    expect(scan(report, "TestB => FLAKE-1", "go.jsonl")).toEqual({ label: "FLAKE-1", match: "FAIL acme/pkg TestB" });
    expect(scan(report, "flaky socket => FLAKE-2", "go.jsonl")).toEqual({ label: "FLAKE-2", match: "dial tcp: flaky socket reset" });
    expect(scan([event("output", "TestA", "flaky socket\n"), event("pass", "TestA")].join("\n"), "flaky socket => FLAKE-2", "go.jsonl")).toBeNull();
  });
  it("JUnit XML: failure and error elements of failed test cases, entities decoded", () => {
    const xml = `<?xml version="1.0"?><testsuite><testcase classname="cart.Spec" name="adds item" time="1"/><testcase classname="cart.Spec" name="passing flaky"></testcase>
<testcase classname="cart.Spec" name="checkout flow"><failure message="socket &quot;reset&quot;" type="Err">stack line&#10;at Cart.java:1</failure></testcase>
<testcase classname="cart.Spec" name="setup"><error type="Boom"><![CDATA[connection <closed>]]></error></testcase></testsuite>`;
    expect(scan(xml, "adds item => FLAKE-1", "r.xml")).toBeNull();
    expect(scan(xml, "passing flaky => FLAKE-1", "r.xml")).toBeNull();
    expect(scan(xml, "cart.Spec checkout flow => FLAKE-1", "r.xml")).toEqual({ label: "FLAKE-1", match: "FAIL cart.Spec checkout flow" });
    expect(scan(xml, 'socket "reset" => FLAKE-2', "r.xml")?.label).toBe("FLAKE-2");
    expect(scan(xml, "Cart.java => FLAKE-3", "r.xml")?.label).toBe("FLAKE-3");
    expect(scan(xml, "connection <closed> => FLAKE-4", "r.xml")?.label).toBe("FLAKE-4");
    expect(scan('<testsuite><testcase classname="a" name="passing flaky"/></testsuite>', "passing flaky => FLAKE-1", "r.xml")).toBeNull();
  });
  it("any other text is still matched line by line, and unparseable report lookalikes fall back to text", () => {
    expect(scan("setup ok\nsocket hang up\n", SOCKET, "out.log")?.label).toBe("FLAKE-1");
    expect(scan('{"not":"a report"}\nsocket hang up', SOCKET, "x.json")?.label).toBe("FLAKE-1");
    expect(scan("<html>socket hang up</html>", SOCKET, "x.html")?.label).toBe("FLAKE-1");
  });
});

const goEvents = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");
// One partition ran and passed; the other did not compile.
const GO_BUILD_FAILED = goEvents(
  { Action: "output", Package: "app/ok", Test: "TestFine", Output: "--- PASS: TestFine\n" }, { Action: "pass", Package: "app/ok", Test: "TestFine" }, { Action: "pass", Package: "app/ok" },
  { Action: "output", Package: "app/db", Output: '# app/db\ncgo: C compiler "gcc" not found\n' }, { Action: "output", Package: "app/db", Output: "FAIL\tapp/db [build failed]\n" }, { Action: "fail", Package: "app/db" });
const goFailedTest = (output: string) => goEvents({ Action: "output", Package: "app/pay", Test: "TestPay", Output: `${output}\n` }, { Action: "fail", Package: "app/pay", Test: "TestPay" }, { Action: "fail", Package: "app/pay" });

describe("build and setup failures in reports", () => {
  const evidence = (data: string, text = SOCKET, name = "report.json") => scanEvidence(zip([{ name, data }]), rules(text));
  it("Go: a package-level fail with [build failed] is a BUILD FAILED entry; a package-level fail of a failed test is not", () => {
    expect(evidence(GO_BUILD_FAILED)).toEqual({ report: true, hit: null, build: "app/db" });
    expect(evidence(GO_BUILD_FAILED, 'C compiler => FLAKE-8')).toMatchObject({ hit: { label: "FLAKE-8", match: 'cgo: C compiler "gcc" not found' }, build: "app/db" });
    expect(evidence(GO_BUILD_FAILED.replace("[build failed]", "[setup failed]")).build).toBe("app/db");
    expect(evidence(goFailedTest("Error: socket hang up"))).toMatchObject({ report: true, hit: { label: "FLAKE-1" }, build: null });
    expect(failedTestNames(GO_BUILD_FAILED)).toEqual(["db (build failed)"]);
  });
  it("Jest: a suite that failed to run without assertions is a setup failure; failed assertions are not", () => {
    const suite = (extra: object) => JSON.stringify({ testResults: [{ name: "/src/cart.test.ts", status: "failed", assertionResults: [], ...extra }] });
    expect(evidence(suite({ message: "Cannot find module './cart'" }), "nothing => X").build).toBe("/src/cart.test.ts");
    expect(evidence(suite({ testExecError: { message: "boom" } }), "nothing => X").build).toBe("/src/cart.test.ts");
    expect(evidence(suite({ message: "" }), "nothing => X")).toMatchObject({ report: true, build: null });
    const failedAssertion = JSON.stringify({ testResults: [{ name: "/src/cart.test.ts", status: "failed", assertionResults: [{ status: "failed", fullName: "cart pays", failureMessages: ["x"] }] }] });
    expect(evidence(failedAssertion, "nothing => X").build).toBeNull();
  });
  it("a zip without a recognized report says so", () => {
    expect(scanEvidence(zip([{ name: "a.txt", data: "socket hang up" }]), rules(SOCKET))).toMatchObject({ report: false, hit: { label: "FLAKE-1" } });
  });
});

const ARTIFACT_ZIP = zip([{ name: "report.txt", data: "step 1 ok\nError: socket hang up\n", deflate: true }]);
function artifactSetup(artifacts: { id: number; name: string; size_in_bytes?: number; expired?: boolean; created_at?: string }[] = [{ id: 7, name: "test-results-unit", created_at: at(5) }]) {
  const data = syntheticRun(), github = fakeGithub(data), settings = flakeSettings(SOCKET, "test-results-*");
  const listings: string[] = [];
  const request: typeof github.request = async (path, init) => {
    if (!path.includes("/artifacts?")) return github.request(path, init);
    listings.push(path);
    return { body: { artifacts: artifacts.map((a) => ({ size_in_bytes: 100, expired: false, ...a })) }, hasNext: false };
  };
  const downloads: string[] = [];
  const fetchArtifact = vi.fn(async (path: string) => { downloads.push(path); return ARTIFACT_ZIP; });
  const logs = vi.fn(async (_path: string, _scan?: LogScan) => "before\n##[error] broken");
  const config = (over: Partial<FlakeConfig> = {}): FlakeConfig => ({ repository: "o/r", ...settings, classify: {}, since: "2020", ...over });
  const scan = (over: Partial<FlakeConfig> = {}) => ({ config: config(over), fetchArtifact, cache: new Map() });
  return { data, ...github, request, listings, downloads, fetchArtifact, logs, config, scan, context: (attempt: number) => runContext(data, attempt) };
}
const byName = (jobs: JobRecord[], name: string) => jobs.find((j) => j.jobName === name)!;

describe("artifact attribution", () => {
  it("attributes an artifact hit to the only real failure of the attempt", async () => {
    const t = artifactSetup();
    const jobs = await fetchAttemptJobs(t.request, "o/r", t.context(1), t.logs, t.scan());
    expect(byName(jobs, "Integration tests").signature).toMatchObject({ rules: t.config().hash, label: "FLAKE-1", match: "Error: socket hang up", source: "artifact" });
    expect(byName(jobs, "Lint").signature).toBeUndefined(); // runner loss is not a candidate
    expect(t.downloads).toEqual(["/repos/o/r/actions/artifacts/7/zip"]);
    expect(classifyJobs(jobs, { flakeRules: t.config().rules, flakeHash: t.config().hash }).find((c) => c.job.jobName === "Integration tests")).toMatchObject({ class: "flake", evidence: "FLAKE-1: Error: socket hang up" });
  });
  it("does not attribute when two failures of the attempt would otherwise be real", async () => {
    const t = artifactSetup();
    const jobs = await fetchAttemptJobs(t.request, "o/r", t.context(2), t.logs, t.scan());
    for (const name of ["Integration tests", "CI summary"]) expect(byName(jobs, name).signature).toEqual({ rules: t.config().hash, label: null, match: null, source: null });
    expect(t.listings).toHaveLength(1); // the artifacts are still listed: a recognized report would override the logs
    // An aggregator is a consequence, not a candidate: the lone real failure owns the artifact again.
    const alone = await fetchAttemptJobs(t.request, "o/r", t.context(2), t.logs, t.scan({ classify: { aggregatorJobs: ["CI summary"] } }));
    expect(byName(alone, "Integration tests").signature?.source).toBe("artifact");
  });
  it("downloads each artifact once per attempt and rules version, and only the matching, live, in-window, small ones", async () => {
    const t = artifactSetup([{ id: 1, name: "other-logs" }, { id: 2, name: "test-results-old", expired: true }, { id: 3, name: "test-results-big", size_in_bytes: 21 * 1024 * 1024 },
      { id: 4, name: "test-results-late", created_at: at(120) }, { id: 5, name: "test-results-unit", created_at: at(5) }].map((a) => ({ created_at: at(5), ...a })));
    const scan = t.scan();
    await fetchAttemptJobs(t.request, "o/r", t.context(1), t.logs, scan);
    await fetchAttemptJobs(t.request, "o/r", t.context(1), t.logs, scan);
    expect(t.downloads).toEqual(["/repos/o/r/actions/artifacts/5/zip"]);
    expect(t.listings).toHaveLength(1);
    await fetchAttemptJobs(t.request, "o/r", t.context(1), t.logs, { ...scan, config: t.config({ hash: "next" }) });
    expect(t.downloads).toHaveLength(2);
  });
  it("a log hit decides when the artifacts hold no recognized report, and a job whose log cannot be read stays unmarked", async () => {
    const t = artifactSetup();
    const hit = vi.fn(async (_path: string, scan?: LogScan) => { scan!.hit = { label: "FLAKE-2", match: "from log" }; return "before\n##[error] broken"; });
    const jobs = await fetchAttemptJobs(t.request, "o/r", t.context(1), hit, t.scan());
    expect(byName(jobs, "Integration tests").signature).toMatchObject({ label: "FLAKE-2", source: "log" });
    const unreadable = await fetchAttemptJobs(t.request, "o/r", t.context(1), async () => { throw new Error("Log fetch 404"); }, t.scan());
    expect(byName(unreadable, "Integration tests").signature).toBeUndefined();
  });
  it("no rules means no scan state at all", async () => {
    const t = artifactSetup();
    const jobs = await fetchAttemptJobs(t.request, "o/r", t.context(1), t.logs);
    expect(jobs.every((j) => j.signature === undefined)).toBe(true);
    expect(t.logs.mock.calls.every(([, scan]) => scan === undefined)).toBe(true);
  });
});

describe("test reports win over log lines", () => {
  const LOCKED = "lock_busy => FLAKE-7";
  const dump = (scan?: LogScan) => { scan!.hit = { label: "FLAKE-7", match: "ERROR: orders_lock_busy" }; return "before\n##[error] broken"; };
  const run = async (report: string | null, logHit = true, rule = LOCKED) => {
    const t = artifactSetup([{ id: 7, name: "test-results-unit", created_at: at(5) }]);
    if (report !== null) t.fetchArtifact.mockImplementation(async (path: string) => { t.downloads.push(path); return zip([{ name: "report.json", data: report }]); });
    const settings = flakeSettings(rule, "test-results-*");
    const config = t.config({ ...settings });
    const jobs = await fetchAttemptJobs(t.request, "o/r", t.context(1), vi.fn(async (_path: string, scan?: LogScan) => logHit ? dump(scan) : "before\n##[error] broken"), { config, fetchArtifact: t.fetchArtifact, cache: new Map() });
    const target = byName(jobs, "Integration tests");
    return { jobs, target, config, verdict: (all: JobRecord[] = jobs) => classifyJobs(all, { flakeRules: config.rules, flakeHash: config.hash }).find((c) => c.job === target)! };
  };

  it("a build-failed package next to a passing partition is real, whatever the log matches", async () => {
    const { target, verdict } = await run(GO_BUILD_FAILED);
    expect(target.signature).toMatchObject({ label: null, source: null });
    expect(target.buildFailure).toEqual({ match: "app/db" });
    expect(verdict()).toMatchObject({ class: "real", reason: "build or setup failed", evidence: "app/db" });
    // Not even a pass at the same sha makes it a flake.
    const pass = job({ jobId: 99, runId: 2, jobName: "Integration tests", headSha: target.headSha, conclusion: "success" });
    expect(verdict([...[target], pass])).toMatchObject({ class: "real", reason: "build or setup failed" });
  });
  it("a failed test whose output matches a rule is a flake with the label", async () => {
    const { target, verdict } = await run(goFailedTest("ERROR: orders_lock_busy"), false);
    expect(target.signature).toMatchObject({ label: "FLAKE-7", source: "artifact" });
    expect(target.buildFailure).toBeNull();
    expect(verdict()).toMatchObject({ class: "flake", flakeLabel: "FLAKE-7" });
  });
  it("a failed test that does not match gets no label even when the log matches; only a same-sha pass makes it a flake", async () => {
    const { target, verdict } = await run(goFailedTest("assertion failed: want 1, got 2"));
    expect(target.signature).toMatchObject({ label: null, match: null, source: null });
    expect(verdict()).toMatchObject({ class: "real", reason: "same job never passed at this sha" });
    const pass = job({ jobId: 99, runId: 2, jobName: "Integration tests", headSha: target.headSha, conclusion: "success" });
    expect(verdict([target, pass])).toMatchObject({ class: "flake", reason: "same job passed at the same sha" });
  });
  it("without a recognized report the log decides", async () => {
    const { target } = await run(null);
    expect(target.signature).toMatchObject({ label: "FLAKE-7", source: "log" });
  });
  it("a build failure line in the log (no report) makes the job real", async () => {
    const t = artifactSetup([]);
    const log = vi.fn(async (_path: string, scan?: LogScan) => { dump(scan); scan!.build = 'cgo: C compiler "gcc" not found'; return "x\n##[error] broken"; });
    const jobs = await fetchAttemptJobs(t.request, "o/r", t.context(1), log, t.scan());
    const c = classifyJobs(jobs, { flakeRules: t.config().rules, flakeHash: t.config().hash }).find((x) => x.job.jobName === "Integration tests")!;
    expect(c).toMatchObject({ class: "real", reason: "build or setup failed", evidence: 'cgo: C compiler "gcc" not found' });
  });
  it("a failure annotation about a missing compiler is real even if the same job passed at the same sha", () => {
    const failing = failed({ annotations: [failure('cgo: C compiler "gcc" not found')] });
    const pass = job({ jobId: 2, runId: 2, jobName: failing.jobName, headSha: failing.headSha });
    const h = flakeSettings(SOCKET, "");
    const label = { rules: h.hash, label: "FLAKE-9", match: "boom", source: "log" as const };
    for (const j of [failing, { ...failing, signature: label }]) expect(classifyJobs([j, pass], { flakeRules: h.rules, flakeHash: h.hash })[0]).toMatchObject({ class: "real", reason: "build or setup failed", evidence: 'cgo: C compiler "gcc" not found' });
  });
});

describe("re-scan of stored jobs", () => {
  const signal = () => new AbortController().signal;
  function storeWith(...jobs: JobRecord[]) {
    const db = createFakePluginHost().bb.storage.database();
    for (const sql of jobMigrations) db.prepare(sql).run();
    const store = createJobStore(db);
    // Jobs of one run attempt are saved together: saving an attempt replaces its jobs.
    for (const j of jobs) store.saveAttempt(j.repository, j.runId, j.attempt, jobs.filter((x) => x.runId === j.runId && x.attempt === j.attempt), true);
    return store;
  }
  const real = (n: number, over: Partial<JobRecord> = {}) => failed({ jobId: n, runId: n, headSha: String(n).repeat(40).slice(0, 40), ...over }, n);
  const config = (text: string, over: Partial<FlakeConfig> = {}): FlakeConfig => ({ repository: "acme/widgets", ...flakeSettings(text, ""), classify: {}, since: "2020", ...over });
  const stored = (store: ReturnType<typeof storeWith>) => store.listJobs({ repository: "acme/widgets", since: "2020", until: "9999" });
  const request = async () => ({ body: { artifacts: [] }, hasNext: false });
  const logging = (hitOn: (path: string) => boolean) => vi.fn(async (path: string, scan?: LogScan) => { if (hitOn(path)) scan!.hit = { label: "FLAKE-1", match: "socket hang up" }; return ""; });

  it("scans an already stored real job when rules are configured, then stays quiet until the rules change", async () => {
    const store = storeWith(real(1), real(2), job({ jobId: 3, runId: 3 }));
    const text = logging((path) => path.includes("/jobs/2/"));
    const backfill = createBackfill({ store, request, fetchText: text });
    expect(await backfill.step(signal(), config(SOCKET))).toMatchObject({ processed: 0 });
    expect(text.mock.calls.map(([path]) => path)).toEqual(["/repos/acme/widgets/actions/jobs/2/logs", "/repos/acme/widgets/actions/jobs/1/logs"]); // newest first
    const [first, second] = stored(store).filter((j) => j.conclusion === "failure");
    expect(first!.signature).toEqual({ rules: config(SOCKET).hash, label: null, match: null, source: null });
    expect(second!.signature).toMatchObject({ label: "FLAKE-1", match: "socket hang up", source: "log" });
    const opts = { flakeRules: config(SOCKET).rules, flakeHash: config(SOCKET).hash };
    expect(classifyJobs(stored(store), opts).map((c) => c.class)).toEqual(["real", "flake"]); // runs 1 and 2; the passing job is not a failure
    await backfill.step(signal(), config(SOCKET));
    expect(text).toHaveBeenCalledTimes(2);
    // Another rules version scans again.
    await backfill.step(signal(), config("other pattern => FLAKE-3"));
    expect(text).toHaveBeenCalledTimes(4);
    expect(stored(store).filter((j) => j.conclusion === "failure").every((j) => j.signature?.rules === config("other pattern => FLAKE-3").hash)).toBe(true);
  });
  it("a stored job scanned under other scan semantics (another rules hash) is scanned once more, and its stale label is dropped", async () => {
    const stale = { rules: "scanned-before-reports-won", label: "FLAKE-7", match: "ERROR: orders_lock_busy", source: "log" as const };
    const store = storeWith(real(1, { signature: stale }));
    const text = logging(() => false);
    const backfill = createBackfill({ store, request, fetchText: text });
    const opts = { flakeRules: config(SOCKET).rules, flakeHash: config(SOCKET).hash };
    expect(classifyJobs(stored(store), opts)[0]!.class).toBe("real"); // the stale label no longer counts
    await backfill.step(signal(), config(SOCKET)); await backfill.step(signal(), config(SOCKET));
    expect(text).toHaveBeenCalledTimes(1);
    expect(stored(store)[0]!.signature).toEqual({ rules: config(SOCKET).hash, label: null, match: null, source: null });
  });
  it("a recognized report decides over a matching log, and a build failure is stored on the job", async () => {
    const store = storeWith(real(1, { createdAt: at(1), startedAt: at(2), completedAt: at(3) }));
    const listing = vi.fn(async (_path: string) => ({ body: { artifacts: [{ id: 9, name: "test-results-a", size_in_bytes: 10, expired: false, created_at: at(2) }] }, hasNext: false }));
    const text = logging(() => true);
    const backfill = createBackfill({ store, request: listing, fetchText: text, fetchArtifact: async () => zip([{ name: "r.json", data: GO_BUILD_FAILED }]), maxPerStep: 10 });
    await backfill.step(signal(), { ...config("lock_busy => FLAKE-7"), ...flakeSettings("lock_busy => FLAKE-7", "test-results-*") });
    // The log is still read once for runner-loss evidence after the first error; its rule hit does not count over the report.
    expect(text).toHaveBeenCalledTimes(1);
    const [job] = stored(store);
    expect(job!.buildFailure).toEqual({ match: "app/db" });
    expect(job!.signature).toMatchObject({ label: null, source: null });
    expect(classifyJobs([job!], {})[0]).toMatchObject({ class: "real", reason: "build or setup failed" });
  });
  it("a sibling whose refreshed log shows a runner shutdown stops being a candidate, so the report goes to the lone remaining job", async () => {
    const store = storeWith(real(1, { createdAt: at(1), startedAt: at(2), completedAt: at(3) }), real(2, { runId: 1, headSha: "1".repeat(40), jobName: "Integration", createdAt: at(1), startedAt: at(2), completedAt: at(3) }));
    const listing = vi.fn(async (_path: string) => ({ body: { artifacts: [{ id: 9, name: "test-results-a", size_in_bytes: 10, expired: false, created_at: at(2) }] }, hasNext: false }));
    const text = vi.fn(async (path: string) => path.includes("/jobs/2/") ? "x\n##[error]Process completed with exit code 130.\n##[error]The runner has received a shutdown signal." : "y\n##[error]Process completed with exit code 1.");
    const backfill = createBackfill({ store, request: listing, fetchText: text, fetchArtifact: async () => zip([{ name: "r.json", data: GO_BUILD_FAILED }]), maxPerStep: 10 });
    await backfill.step(signal(), { ...config("lock_busy => FLAKE-7"), ...flakeSettings("lock_busy => FLAKE-7", "test-results-*") });
    const classified = classifyJobs(stored(store), {});
    expect(classified.find((c) => c.job.jobId === 2)).toMatchObject({ class: "runner_loss" });
    expect(classified.find((c) => c.job.jobId === 1)).toMatchObject({ class: "real", reason: "build or setup failed" });
  });
  it("with a tight budget every step stores some re-scanned attempts instead of refetching logs forever", async () => {
    const store = storeWith(...[1, 2, 3, 4, 5].map((n) => real(n, { createdAt: at(n), startedAt: at(n), completedAt: at(n) })));
    const listing = vi.fn(async (_path: string) => ({ body: { artifacts: [] }, hasNext: false }));
    const text = vi.fn(async () => "y\n##[error]Process completed with exit code 1.");
    const backfill = createBackfill({ store, request: listing, fetchText: text, budgetPerHour: 100_000, maxPerStep: 3 });
    const flake = { ...config("lock_busy => FLAKE-7"), ...flakeSettings("lock_busy => FLAKE-7", "test-results-*") };
    const done = () => stored(store).filter((j) => j.signature?.rules === flake.hash).length;
    await backfill.step(signal(), flake);
    expect(done()).toBeGreaterThan(0);
    for (let i = 0; i < 6 && done() < 5; i++) await backfill.step(signal(), flake);
    expect(done()).toBe(5);
  });
  it("spends the backfill budget, newest job first, and continues on the next step", async () => {
    const store = storeWith(real(1), real(2), real(3));
    const text = logging(() => false);
    const backfill = createBackfill({ store, request, fetchText: text, budgetPerHour: 2, maxPerStep: 2 });
    await backfill.step(signal(), config(SOCKET));
    expect(text.mock.calls.map(([path]) => path.match(/jobs\/(\d+)/)![1])).toEqual(["3", "2"]);
    expect(stored(store).map((j) => j.signature !== undefined)).toEqual([false, true, true]);
  });
  it("uses the artifacts of a run with a single real failure and counts their requests", async () => {
    const store = storeWith(real(1, { createdAt: at(1), startedAt: at(2), completedAt: at(3) }));
    const listing = vi.fn(async (_path: string) => ({ body: { artifacts: [{ id: 9, name: "test-results-a", size_in_bytes: 10, expired: false, created_at: at(2) }] }, hasNext: false }));
    const fetchArtifact = vi.fn(async (_path: string, _max: number) => ARTIFACT_ZIP);
    const backfill = createBackfill({ store, request: listing, fetchText: logging(() => false), fetchArtifact, maxPerStep: 10 });
    await backfill.step(signal(), { ...config(SOCKET), ...flakeSettings(SOCKET, "test-results-*") });
    expect(stored(store)[0]!.signature).toMatchObject({ label: "FLAKE-1", source: "artifact" });
    expect(listing).toHaveBeenCalledTimes(1); expect(fetchArtifact).toHaveBeenCalledTimes(1);
  });
  it("ignores jobs the classifier already decided and does nothing without rules", async () => {
    const store = storeWith(real(1, { annotations: [failure("socket hang up")] }), real(2, { annotations: [failure("The runner has received a shutdown signal")] }));
    const text = logging(() => false);
    const backfill = createBackfill({ store, request, fetchText: text });
    await backfill.step(signal(), config(SOCKET));
    expect(text).not.toHaveBeenCalled();
    await backfill.step(signal(), undefined);
    await backfill.step(signal(), config("# nothing"));
    expect(text).not.toHaveBeenCalled();
  });
  it("does not retry a job whose log cannot be read and pauses on a rate limit", async () => {
    const store = storeWith(real(1));
    const broken = vi.fn(async () => { throw new Error("Log fetch 404"); });
    const backfill = createBackfill({ store, request, fetchText: broken });
    await backfill.step(signal(), config(SOCKET)); await backfill.step(signal(), config(SOCKET));
    expect(broken).toHaveBeenCalledTimes(1);
    expect(stored(store)[0]!.signature).toBeUndefined();
    const limited = createBackfill({ store, request, fetchText: async () => { throw new Error("Log fetch 429"); }, now: () => 1000 });
    expect(await limited.step(signal(), config("another => FLAKE-4"))).toMatchObject({ pausedUntil: 901000 });
  });
});

describe("failedTestNames", () => {
  it("lists only the failed tests of Jest, Go test2json and JUnit reports, without their output", () => {
    const jest = JSON.stringify({ testResults: [{ name: "/work/app/cart.test.ts", status: "failed", assertionResults: [{ status: "passed", fullName: "cart adds" }, { status: "failed", fullName: "cart removes", failureMessages: ["Error: secret=abc"] }] }, { name: "/work/app/broken.test.ts", status: "failed", message: "SyntaxError", assertionResults: [] }] });
    expect(failedTestNames(jest)).toEqual(["cart removes", "broken.test.ts"]);
    const go = ['{"Action":"run","Package":"acme/widgets/store","Test":"TestA"}', '{"Action":"output","Package":"acme/widgets/store","Test":"TestA","Output":"token=abc\\n"}', '{"Action":"fail","Package":"acme/widgets/store","Test":"TestA"}', '{"Action":"pass","Package":"acme/widgets/store","Test":"TestB"}'].join("\n");
    expect(failedTestNames(go)).toEqual(["store.TestA"]);
    expect(failedTestNames('<testsuite><testcase classname="a.B" name="ok"/><testcase classname="a.B" name="bad"><error message="x"/></testcase><testcase name="bare"><failure/></testcase></testsuite>')).toEqual(["a.B.bad", "bare"]);
    expect(failedTestNames("plain log")).toBeNull();
    expect(failedTestNames(JSON.stringify({ testResults: [] }))).toEqual([]);
  });
});
