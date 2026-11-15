import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { expect, it } from 'vitest';
import plugin from './server.js';

it('validates price settings with the pricing parser before saving', async () => {
  const { bb,harness }=createFakePluginHost({ pluginId:'tokenomos' });
  try {
    plugin(bb);
    for (const priceOverrides of ['{"model":null}','{"model":{"input":-1}}','{"model":{"input":100001}}','{"model":{"unknown":1}}','[]','not json']) {
      await expect(harness.behavior.setSettings({priceOverrides})).rejects.toThrow();
    }
    await harness.behavior.setSettings({priceOverrides:'{"claude-sonnet-5-5":{"input":7,"output":17}}'});
    await harness.behavior.setSettings({priceOverrides:'{}'});
  } finally { await harness.lifecycle.dispose(); }
});
