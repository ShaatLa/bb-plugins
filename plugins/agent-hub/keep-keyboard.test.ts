// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { keepKeyboard } from './keep-keyboard';

let stop: () => void, at: ReturnType<typeof vi.fn>, now = 0;
const point = (x: number, y = 5, identifier = 1) => ({ identifier, clientX: x, clientY: y });
const fire = (target: EventTarget, type: string, touches: object[], changed: object[]) => {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: object[]; changedTouches: object[] };
  Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changed }, timeStamp: { value: now } });
  return target.dispatchEvent(event);
};
// A whole touch on an element: returns whether touchend was left uncancelled.
const tap = (el: Element, { moveTo, endAt = el, hold = 80, cancel = false }: { moveTo?: [number, number][]; endAt?: Element | null; hold?: number; cancel?: boolean } = {}) => {
  at.mockReturnValue(endAt);
  fire(el, 'touchstart', [point(5)], [point(5)]);
  for (const [x, y] of moveTo ?? []) fire(el, 'touchmove', [point(x, y)], [point(x, y)]);
  now += hold;
  if (cancel) return fire(el, 'touchcancel', [], [point(5)]);
  return fire(el, 'touchend', [], [point(5)]);
};
beforeEach(() => {
  document.body.innerHTML = '<div data-chat-column><p id="text">Agent text</p><button id="copy">Copy</button><button id="off" disabled>Off</button></div>'
    + '<div data-composer-stack><div id="editor" contenteditable="true" tabindex="0"></div><button id="send">Send</button><button id="picker" data-state="closed" aria-haspopup="dialog">Model</button></div><button id="outside">Outside</button>';
  at = vi.fn(); Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: at });
  stop = keepKeyboard(); (document.getElementById('editor') as HTMLElement).focus();
});
afterEach(() => { stop(); delete (document as { elementFromPoint?: unknown }).elementFromPoint; });
const el = (id: string) => document.getElementById(id)!;
const clicks = (id: string) => { const spy = vi.fn(); el(id).addEventListener('click', spy); return spy; };

it('acts on a tap on a chat control without moving focus off the editor', () => {
  const copy = clicks('copy');
  expect(tap(el('copy'))).toBe(false); expect(copy).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(el('editor'));
});
it('leaves a tap on the chat itself, a moved touch, a long press and a cancelled touch to the browser', () => {
  const copy = clicks('copy');
  expect(tap(el('text'))).toBe(true);
  expect(tap(el('copy'), { moveTo: [[30, 5]] })).toBe(true);
  expect(tap(el('copy'), { hold: 700 })).toBe(true);
  expect(tap(el('copy'), { cancel: true })).toBe(true);
  expect(tap(el('copy'), { endAt: el('text') })).toBe(true);
  expect(copy).not.toHaveBeenCalled();
});
it('closes the keyboard on a downward swipe', () => {
  tap(el('text'), { moveTo: [[5, 20], [6, 50]] });
  expect(document.activeElement).not.toBe(el('editor'));
});
it('does nothing for a disabled control, a control outside the chat, or while the editor is not focused', () => {
  expect(tap(el('off'))).toBe(true);
  const outside = clicks('outside'); expect(tap(el('outside'))).toBe(true); expect(outside).not.toHaveBeenCalled();
  (el('editor') as HTMLElement).blur();
  const copy = clicks('copy'); expect(tap(el('copy'))).toBe(true); expect(copy).not.toHaveBeenCalled();
});
it('leaves a control that already acted on touchend (Send) alone, so it acts once', () => {
  const send = clicks('send');
  el('send').addEventListener('touchend', event => event.preventDefault());
  expect(tap(el('send'))).toBe(false); expect(send).not.toHaveBeenCalled();
});
it('leaves bb\'s own pickers to the browser, since they open and move focus themselves', () => {
  const picker = clicks('picker'); expect(tap(el('picker'))).toBe(true); expect(picker).not.toHaveBeenCalled();
});
it('stops listening once removed', () => {
  stop(); const copy = clicks('copy');
  expect(tap(el('copy'))).toBe(true); expect(copy).not.toHaveBeenCalled();
  stop = () => {};
});
