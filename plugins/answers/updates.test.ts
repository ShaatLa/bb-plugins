import { expect, it } from 'vitest';
import { bbUpdateAvailable, pluginUpdateCount } from './contacts-footer';

const app = (over: object) => ({ available: { behindSince: null, commitCount: null }, blocked: null, support: { kind: 'supported', mode: 'npm' }, ...over }) as any;
const version = (over: object) => ({ installKind: 'npm', isDevelopment: false, updateAvailable: false, ...over }) as any;
it('follows bb\'s rules for its own update badge', () => {
  expect(bbUpdateAvailable(app({}), null)).toBe(true);
  expect(bbUpdateAvailable(app({ blocked: { reason: 'diverged' } }), null)).toBe(false);
  expect(bbUpdateAvailable(app({ support: { kind: 'unsupported', reason: 'desktop' }, desktopUpdateSupported: true }), null)).toBe(true);
  const source = app({ support: { kind: 'supported', mode: 'source' }, available: { behindSince: '2026-01-01T00:00:00Z', commitCount: 3 } });
  expect(bbUpdateAvailable(source, null, Date.parse('2026-01-01T05:00:00Z'))).toBe(false);
  expect(bbUpdateAvailable(source, null, Date.parse('2026-01-01T06:00:01Z'))).toBe(true);
  expect(bbUpdateAvailable(null, version({ updateAvailable: true }))).toBe(true);
  expect(bbUpdateAvailable(null, version({ updateAvailable: true, installKind: 'desktop' }))).toBe(false);
});
it('counts updates only for plugins bb tracks', () => {
  const plugin = (source: string, provenance: string, updateState: object) => ({ source, provenance, updateState }) as any;
  expect(pluginUpdateCount([
    plugin('git:a', 'catalog', { availableLabel: '1.2.0' }),
    plugin('git:b', 'direct', { availableLabel: '2.0.0', outcome: 'pinned' }),
    plugin('path:/c', 'direct', { availableLabel: '1.0.1' }),
    plugin('builtin:d', 'builtin', { availableLabel: '1.0.1' }),
    plugin('git:e', 'direct', {}),
  ])).toBe(1);
});
