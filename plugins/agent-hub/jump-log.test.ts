// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { watchJumps } from './jump-log';
afterEach(() => vi.unstubAllGlobals());
it('logs a far upward jump no input caused, with the scroll writes before it, and ignores one after a wheel', async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response('{}'))); vi.stubGlobal('fetch', fetch);
  const node = document.createElement('div'); document.body.append(node);
  const stop = watchJumps(node, 'thr_example', () => ({ depth: 2 }));
  node.scrollTop = 5000; node.dispatchEvent(new Event('scroll'));
  node.scrollTop = 100; node.dispatchEvent(new Event('scroll'));
  expect(fetch).toHaveBeenCalledOnce();
  const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body.where).toBe('jump'); expect(body.message).toContain('jump thr_example 5000->100'); expect(body.message).toContain('"depth":2'); expect(body.stack).toContain('5000->100');
  node.scrollTop = 5000; node.dispatchEvent(new Event('scroll'));
  node.dispatchEvent(new Event('wheel')); node.scrollTop = 100; node.dispatchEvent(new Event('scroll'));
  expect(fetch).toHaveBeenCalledOnce();
  stop(); node.scrollTop = 7; expect(node.scrollTop).toBe(7); node.remove();
});
