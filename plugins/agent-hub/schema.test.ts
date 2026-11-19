import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { migrations } from './schema';
// bb refuses to start when a shipped migration's text changes (comments included); append new migrations instead.
it('keeps shipped migration statements byte-for-byte', () => {
  const digest = createHash('sha256').update(JSON.stringify(migrations.slice(0, 26))).digest('hex').slice(0, 16);
  expect(digest).toBe('b7409db62548ac46');
});
