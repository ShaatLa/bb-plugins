// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { RobotLoader } from './robot-loader';

const lap = (node: Element, name = 'ar-move-q') => { for (const type of ['animationiteration', 'webkitAnimationIteration']) { const event = new Event(type, { bubbles: true }); Object.assign(event, { animationName: name }); node.dispatchEvent(event); } };

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it('the waiting robot now and then dances for five seconds when it faces us mid-lap, the walk holding still', () => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(.1);
  let phase = .43;
  (Element.prototype as any).getAnimations = function () { return [{ currentTime: 13000 * (3 + phase) }]; };
  renderSlot({ component: () => <RobotLoader activity="wait" /> }, {});
  const move = document.querySelector('.ar-move')!;
  lap(move);
  act(() => { vi.advanceTimersByTime(13000 * .43); });
  expect(document.querySelector('.ar-dance')).not.toBeNull(); expect(document.querySelector('.ar-dancing')).not.toBeNull();
  act(() => { vi.advanceTimersByTime(4900); }); expect(document.querySelector('.ar-dance')).not.toBeNull();
  act(() => { vi.advanceTimersByTime(100); });
  expect(document.querySelector('.ar-dance')).toBeNull();
  // A timer that fires off the facing moment (a throttled tab) lets the lap pass without a dance.
  phase = .6; lap(move);
  act(() => { vi.advanceTimersByTime(13000 * .43); });
  expect(document.querySelector('.ar-dance')).toBeNull();
  delete (Element.prototype as any).getAnimations;
});
it('the thinking robot picks a mood for each walk every lap: rubbing its raised chin, or hands behind its back', () => {
  const random = vi.spyOn(Math, 'random').mockReturnValue(.1);
  renderSlot({ component: () => <RobotLoader activity="think" /> }, {});
  const behind = () => document.querySelectorAll('.ar-move circle[r=".45"]').length;
  expect(behind()).toBe(0); expect(document.querySelectorAll('.ar-scratch')).toHaveLength(2);
  random.mockReturnValue(.9); act(() => lap(document.querySelector('.ar-right')!, 'ar-right'));
  expect(behind()).toBe(2); expect(document.querySelectorAll('.ar-scratch')).toHaveLength(0);
});
