// Thin DOM helpers for driving the real app markup from a test.
//
// The app binds some controls with `onclick = fn` (an IDL attribute) and others
// with `addEventListener('click', …)`. A dispatched MouseEvent triggers BOTH in
// jsdom, which is exactly what a real user click does — so `click()` must never
// call the handler directly, or one of the two binding styles would go untested.

/** Resolve a selector or an element to an element, or throw with a useful message. */
function resolve(target: string | Element | null | undefined, root: ParentNode = document): Element | null {
  if (target == null) return null;
  return typeof target === 'string' ? root.querySelector(target) : target;
}

/** querySelector, null-tolerant (returns null instead of throwing). */
export function $(sel: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector(sel) as HTMLElement | null;
}

/** querySelectorAll as a real array. */
export function $$(sel: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll(sel)) as HTMLElement[];
}

/** Like `$`, but fails loudly — for assertions where a missing node IS the bug. */
export function must(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(sel) as HTMLElement | null;
  if (!el) throw new Error(`expected element for selector ${JSON.stringify(sel)}`);
  return el;
}

/**
 * Dispatch a real bubbling MouseEvent. Fires `onclick` and every
 * `addEventListener('click')` listener, in registration order.
 *
 * `view` is deliberately omitted: Vitest exposes the jsdom window through a
 * proxy that fails jsdom's `Window` brand check, so `view: window` throws
 * ("member view is not of type Window"). Nothing in the app reads event.view.
 */
export function click(target: string | Element | null | undefined, init: MouseEventInit = {}): void {
  const el = resolve(target);
  if (!el) throw new Error(`click(): nothing matches ${JSON.stringify(String(target))}`);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}

/** Dispatch a keydown on `target` (defaults to the body). */
export function key(target: string | Element | null | undefined, k: string, init: KeyboardEventInit = {}): void {
  const el = resolve(target, document) ?? document.body;
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
}

export interface PointerInit {
  pointerId?: number;
  pointerType?: string;
  button?: number;
  buttons?: number;
  clientX?: number;
  clientY?: number;
  shiftKey?: boolean;
}

/**
 * Dispatch a pointer event. jsdom implements no PointerEvent, so this is a
 * MouseEvent carrying `type: 'pointerdown'` plus the pointer-only fields the app
 * reads (`pointerId`, `pointerType`, `width`, `height`, `pressure`) grafted on.
 * Listeners registered for 'pointerdown' still fire, because dispatch matches
 * on the event type alone.
 */
export function pointer(
  target: string | Element | null | undefined,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'pointerover' | 'pointerleave',
  init: PointerInit = {},
): void {
  const el = resolve(target) ?? document.body;
  const event = new window.MouseEvent(type, {
    bubbles: true, cancelable: true,
    button: init.button ?? 0, buttons: init.buttons ?? 1,
    clientX: init.clientX ?? 0, clientY: init.clientY ?? 0,
    shiftKey: init.shiftKey ?? false,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' });
  Object.defineProperty(event, 'width', { value: 1 });
  Object.defineProperty(event, 'height', { value: 1 });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  el.dispatchEvent(event);
}

/**
 * Set a control's value and dispatch BOTH `input` and `change`.
 *
 * The app deliberately distinguishes them (the Background panel's colour handler
 * is wired to one of the two), so a test must say which it means. This helper
 * fires `input` first, then `change`, which is the order a browser uses for
 * `<input type=color>`/`<input type=text>` user edits.
 */
export function setInput(target: string | Element | null | undefined, value: string): void {
  const el = resolve(target) as HTMLInputElement | null;
  if (!el) throw new Error(`setInput(): nothing matches ${JSON.stringify(String(target))}`);
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

/** Toggle a checkbox/radio the way a user would (value + input + change). */
export function check(target: string | Element | null | undefined, on = true): void {
  const el = resolve(target) as HTMLInputElement | null;
  if (!el) throw new Error(`check(): nothing matches ${JSON.stringify(String(target))}`);
  el.checked = on;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}
