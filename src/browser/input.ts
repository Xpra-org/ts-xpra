import { XpraClient } from '../core/client.ts';
import type { RemoteWindow } from '../core/types.ts';
import { capability } from '../protocol/value.ts';

export function modifiers(event: Pick<KeyboardEvent, 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'getModifierState'>): string[] {
  return [event.shiftKey && 'shift', event.ctrlKey && 'control', event.altKey && 'mod1', event.metaKey && 'mod3', event.getModifierState('CapsLock') && 'lock', event.getModifierState('NumLock') && 'mod2', event.getModifierState('AltGraph') && 'mod5'].filter((v): v is string => Boolean(v));
}
const names: Record<string, string> = {
  Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', Insert: 'Insert',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End', PageUp: 'Page_Up', PageDown: 'Page_Down',
  CapsLock: 'Caps_Lock', NumLock: 'Num_Lock', ScrollLock: 'Scroll_Lock', Pause: 'Pause', PrintScreen: 'Print', ContextMenu: 'Menu',
  ' ': 'space', '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', '$': 'dollar', '%': 'percent', '&': 'ampersand', "'": 'apostrophe',
  '(': 'parenleft', ')': 'parenright', '*': 'asterisk', '+': 'plus', ',': 'comma', '-': 'minus', '.': 'period', '/': 'slash', ':': 'colon', ';': 'semicolon',
  '<': 'less', '=': 'equal', '>': 'greater', '?': 'question', '@': 'at', '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright', '^': 'asciicircum', '_': 'underscore', '`': 'grave', '{': 'braceleft', '|': 'bar', '}': 'braceright', '~': 'asciitilde',
};
export function keyName(event: Pick<KeyboardEvent, 'key' | 'code' | 'location'>): string | undefined {
  if (event.key === 'Shift') return event.location === 2 ? 'Shift_R' : 'Shift_L';
  if (event.key === 'Control') return event.location === 2 ? 'Control_R' : 'Control_L';
  if (event.key === 'Alt') return event.location === 2 ? 'Alt_R' : 'Alt_L';
  if (event.key === 'Meta') return event.location === 2 ? 'Super_R' : 'Super_L';
  if (event.key === 'AltGraph') return 'ISO_Level3_Shift';
  if (event.code === 'NumpadEnter') return 'KP_Enter';
  return names[event.key] ?? (/^[a-zA-Z0-9]$/.test(event.key) || /^F([1-9]|1\d|2[0-4])$/.test(event.key) ? event.key : undefined);
}
const xButton = (button: number) => button < 3 ? [1, 2, 3][button]! : button + 5;
const clamp = (n: number) => Math.max(-65535, Math.min(65535, Math.round(n)));

export function bindInput(canvas: HTMLCanvasElement, model: () => RemoteWindow, client: XpraClient): () => void {
  const controller = new AbortController(), { signal } = controller;
  const keys = new Map<string, string>();
  const buttons = new Set<number>();
  let last: [number, number] = [0, 0];
  let remainderX = 0, remainderY = 0;
  function position(event: MouseEvent): [number, number] {
    const rect = canvas.getBoundingClientRect(), w = model();
    return [clamp(w.x + (event.clientX - rect.left) * w.width / rect.width), clamp(w.y + (event.clientY - rect.top) * w.height / rect.height)];
  }
  function release() {
    for (const name of keys.values()) client.keyboard(model().id, name, false, []);
    keys.clear();
    for (const button of buttons) client.pointer(model().id, last, { modifiers: [], buttons: [] }, button, false);
    buttons.clear(); client.focusWindow(0);
  }
  canvas.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const name = keyName(event); if (!name) return;
    event.preventDefault(); keys.set(event.code || event.key, name);
    client.keyboard(model().id, name, true, modifiers(event), event.key.length === 1 ? event.key : '');
  }, { signal });
  canvas.addEventListener('keyup', event => {
    const code = event.code || event.key, name = keys.get(code) ?? keyName(event); if (!name) return;
    event.preventDefault(); keys.delete(code); client.keyboard(model().id, name, false, modifiers(event));
  }, { signal });
  canvas.addEventListener('pointerdown', event => {
    event.preventDefault(); canvas.focus(); client.focusWindow(model().id, modifiers(event));
    canvas.setPointerCapture(event.pointerId); last = position(event); const button = xButton(event.button); buttons.add(button);
    client.pointer(model().id, last, { modifiers: modifiers(event), buttons: [...buttons], 'window-position': [last[0] - model().x, last[1] - model().y] }, button, true);
  }, { signal });
  canvas.addEventListener('pointermove', event => {
    last = position(event); client.pointer(model().id, last, { modifiers: modifiers(event), buttons: [...buttons], 'window-position': [last[0] - model().x, last[1] - model().y] });
  }, { signal });
  canvas.addEventListener('pointerup', event => {
    last = position(event); const button = xButton(event.button); buttons.delete(button);
    client.pointer(model().id, last, { modifiers: modifiers(event), buttons: [...buttons] }, button, false);
    if (!buttons.size && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }, { signal });
  canvas.addEventListener('pointercancel', release, { signal });
  canvas.addEventListener('lostpointercapture', () => { if (buttons.size) release(); }, { signal });
  canvas.addEventListener('focus', () => client.focusWindow(model().id), { signal });
  canvas.addEventListener('blur', release, { signal });
  window.addEventListener('blur', release, { signal });
  canvas.addEventListener('contextmenu', e => e.preventDefault(), { signal });
  canvas.addEventListener('wheel', event => {
    event.preventDefault(); last = position(event);
    const factor = event.deltaMode === 1 ? 1 / 3 : event.deltaMode === 2 ? model().height / 100 : 1 / 100;
    const caps = client.snapshot().capabilities;
    const precise = capability(caps, 'wheel.precise') === true || capability(caps, 'wheel.emulation') === true;
    const x = event.deltaX * factor, y = event.deltaY * factor;
    remainderX += x; remainderY += y;
    const sendX = precise ? x : Math.trunc(remainderX), sendY = precise ? y : Math.trunc(remainderY);
    if (sendX) client.wheel(model().id, sendX < 0 ? 6 : 7, Math.round(sendX * 1000), last, modifiers(event), [...buttons]);
    if (sendY) client.wheel(model().id, sendY < 0 ? 4 : 5, Math.round(sendY * 1000), last, modifiers(event), [...buttons]);
    remainderX = precise ? 0 : remainderX - sendX; remainderY = precise ? 0 : remainderY - sendY;
  }, { signal, passive: false });
  return () => { release(); controller.abort(); };
}
