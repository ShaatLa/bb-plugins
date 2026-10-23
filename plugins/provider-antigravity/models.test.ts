import test from "node:test";
import assert from "node:assert/strict";
import { parseModels } from "./models.ts";

test("keeps Google families including Argon and excludes Claude and GPT", () => {
  const models = parseModels("claude-opus-high\tClaude Opus (High)\ngemini-4-argon-low\tGemini 4 Argon (Low)\ngemini-4-argon-max\tGemini 4 Argon (Max)\ngpt-oss-120b-medium\tGPT OSS (Medium)\ngemini-future\tGemini Future\ngemini-4-argon-low\tGemini 4 Argon (Low)\n");
  assert.equal(models.length, 2);
  assert.deepEqual(models[0].supportedReasoningEfforts.map(option => option.reasoningEffort), ["low", "max"]);
  assert.equal(models[0].displayName, "Gemini 4 Argon");
  assert.equal(models[0].id, "gemini-4-argon");
  assert.equal(models[1].defaultReasoningEffort, "none");
  assert.equal(models.filter(model => model.isDefault).length, 1);
  assert.throws(() => parseModels("not a model catalog"));
  assert.throws(() => parseModels("claude-next-high\tClaude Next (High)\ngpt-oss-medium\tGPT OSS (Medium)"));
});
