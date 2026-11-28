// On a phone the composer keeps its keyboard while the owner works the chat, the queue and their menus: iOS closes it
// whenever a tap moves focus, so a tap on a control there acts without moving focus. A downward swipe over them, or a tap
// on the chat itself, still lets the editor go and the keyboard close.
// Agent Hub's own popovers render in a portal outside the chat column, so they opt in.
const SCOPE = '[data-chat-column], [data-composer-stack], [data-keeps-keyboard], [role=menu], [role=listbox]';
const CONTROL = 'button, a[href], summary, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=tab], [role=switch], [role=checkbox], [role=radio], input[type=checkbox], input[type=radio]';
const EDITOR = '[data-composer-stack] [contenteditable="true"]';
// bb's own pickers and popovers (model, permission mode, voice, cost, context) open and move focus themselves, so a tap on one
// is left to the browser; Agent Hub's own menus open on click and keep focus where it is.
const OWN_FOCUS = '[data-state], [aria-haspopup="dialog"], [aria-haspopup="listbox"]';

export function keepKeyboard(doc: Document = document) {
  let start: { id: number; x: number; y: number; at: number; starts: number; control: Element | null; moved: boolean } | null = null, starts = 0;
  const editor = () => { const active = doc.activeElement; return active instanceof HTMLElement && active.matches(EDITOR) ? active : null; };
  const own = (event: TouchEvent) => start && Array.from(event.changedTouches).find(touch => touch.identifier === start!.id);
  const onStart = (event: TouchEvent) => {
    starts++;
    const touch = event.touches.length === 1 ? event.changedTouches[0] : undefined, target = event.target instanceof Element ? event.target : null;
    start = touch && target?.closest(SCOPE) && editor() ? { id: touch.identifier, x: touch.clientX, y: touch.clientY, at: event.timeStamp, starts, control: target.closest(CONTROL), moved: false } : null;
  };
  const onMove = (event: TouchEvent) => {
    const touch = own(event);
    if (!start || !touch) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    // A downward swipe dismisses the keyboard, as in phone messengers; any other movement is a scroll, not a tap.
    if (dy > 30 && dy > Math.abs(dx) * 1.5) { editor()?.blur(); start = null; }
    else if (Math.hypot(dx, dy) > 10) start.moved = true;
  };
  const onEnd = (event: TouchEvent) => {
    const begun = start, touch = own(event); start = null;
    // A control that acted on touchend itself (Send) already cancelled it; a second finger, a scroll or a long press is no tap.
    if (!begun?.control || begun.moved || !touch || event.defaultPrevented || event.touches.length > 0 || begun.starts !== starts || event.timeStamp - begun.at > 500) return;
    const control = begun.control as HTMLElement, hit = doc.elementFromPoint(touch.clientX, touch.clientY);
    if (!hit || !control.contains(hit) || control.matches(':disabled, [aria-disabled="true"]') || control.matches(OWN_FOCUS)) return;
    event.preventDefault(); control.click();
  };
  const onCancel = () => { start = null; };
  doc.addEventListener('touchstart', onStart, { passive: true });
  doc.addEventListener('touchmove', onMove, { passive: true });
  doc.addEventListener('touchend', onEnd, { passive: false });
  doc.addEventListener('touchcancel', onCancel);
  return () => { doc.removeEventListener('touchstart', onStart); doc.removeEventListener('touchmove', onMove); doc.removeEventListener('touchend', onEnd); doc.removeEventListener('touchcancel', onCancel); };
}
