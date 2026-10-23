import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readNativeSettings, setCreditUsage } from "./native-settings.ts";
import { parseCredits } from "./maintenance.ts";

test("credit counts are measured; missing or invalid counts never become zero", () => {
  const output = (value: unknown) => JSON.stringify({ event: "command_result", command: { name: "credits", data: { remaining_credits: value, upgrade_uri: "SECRET_URL" } } });
  for (const value of [0, 125, 12.5]) assert.equal(parseCredits(output(value)), value);
  for (const value of [null, -1, "0"]) assert.throws(() => parseCredits(output(value)));
  assert.throws(() => parseCredits("{}"));
});
test("native credit setting preserves other keys, rejects stale writes, and never exposes raw settings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-settings-test-"));
  const file = path.join(dir, "settings.json");
  try {
    const missing = await readNativeSettings(file);
    assert.equal(missing.useG1Credits, false);
    await writeFile(file, JSON.stringify({ colorScheme: "dark", credentials: "SECRET_TOKEN" }));
    const initial = await readNativeSettings(file);
    assert.ok(!JSON.stringify(initial).includes("SECRET_TOKEN"));
    const enabled = await setCreditUsage(true, initial.revision!, file);
    assert.equal(enabled.useG1Credits, true);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.colorScheme, "dark"); assert.equal(saved.credentials, "SECRET_TOKEN");
    await assert.rejects(setCreditUsage(false, initial.revision!, file), /changed/);
    const text = await readFile(file, "utf8");
    await setCreditUsage(true, enabled.revision!, file);
    assert.equal(await readFile(file, "utf8"), text);
    await setCreditUsage(false, enabled.revision!, file);
    assert.equal((await readNativeSettings(file)).useG1Credits, false);
    await writeFile(file, "malformed SECRET_TOKEN");
    const broken = await readNativeSettings(file);
    assert.equal(broken.useG1Credits, null); assert.equal(broken.editable, false);
    assert.ok(!JSON.stringify(broken).includes("SECRET_TOKEN"));
    await assert.rejects(setCreditUsage(true, enabled.revision!, file));
    assert.equal(await readFile(file, "utf8"), "malformed SECRET_TOKEN");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("native settings symlinks stay intact and cannot be silently replaced", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-symlink-test-"));
  try {
    const target = path.join(dir, "target.json"), file = path.join(dir, "settings.json");
    await writeFile(target, '{"useG1Credits":true}'); await symlink(target, file);
    const value = await readNativeSettings(file);
    assert.equal(value.useG1Credits, true); assert.equal(value.editable, false);
    await assert.rejects(setCreditUsage(false, value.revision!, file), /Symlinked/);
    assert.equal(await readFile(target, "utf8"), '{"useG1Credits":true}');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
