// Test bootstrap for packages/app.
//
// `src/main.ts` is a DOM-heavy ES module with module-scope side effects: it
// queries ~78 ids from the REAL index.html markup on load, spawns an inference
// Worker, and installs handlers. So a test cannot import it against a hand-made
// fixture — it needs (a) the actual markup, read from disk at test time, and
// (b) a browser-ish environment, because jsdom implements none of the APIs the
// app uses.
//
// Everything below is stubbed BEFORE the dynamic import of main.ts, and every
// stub is restored by teardown(), so each test gets a fresh document and a
// fresh module graph (vi.resetModules()).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, vi } from 'vitest';

export { $, $$, must, click, key, pointer, setInput, check } from './dom';
export type { PointerInit } from './dom';

// ---------------------------------------------------------------------------
// source locations (resolved from THIS file, never from process.cwd())
// ---------------------------------------------------------------------------

/** Vite can hand out `import.meta.url` with a `?v=` query; strip it for fs. */
function fileUrl(path: string): string {
  return fileURLToPath(new URL(path.replace(/[?#].*$/, ''), import.meta.url));
}

/** The app shell. Read at test time on purpose — it is edited concurrently. */
export const INDEX_HTML_PATH = fileUrl('../index.html');
/** The module under test. Read at test time too (it is under active edit). */
export const MAIN_TS_PATH = fileUrl('../src/main.ts');

/**
 * Ids main.ts looks up that are NOT in the markup: it creates them itself at
 * runtime (`ensureSplit`, `runReveal`, `ensureRecomputeBox`). Every other
 * `$('#…')` must come from index.html.
 */
export const RUNTIME_CREATED_IDS: readonly string[] = [
  'splitLC', 'splitRC', 'splitDiv2',
  'revealUI', 'revealC', 'revealLine',
  'recompBox',
];

export interface MarkupParts { title: string; bodyHtml: string }

/**
 * Split an index.html source into a title and a body, dropping <script> tags.
 * Defaults to the real file on disk — always prefer that; the `source` override
 * exists so the "markup went missing" diagnostic can be exercised without a
 * fixture copy of the live page.
 */
export function readIndexHtml(source?: string): MarkupParts {
  const html = source ?? readFileSync(INDEX_HTML_PATH, 'utf8');
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  if (!body) throw new Error(`no <body> in ${INDEX_HTML_PATH} — the harness cannot build a document`);
  // The inline classic shell script and the module entry are never executed:
  // main.ts owns everything this harness asserts on, and running a second,
  // concurrently-edited script would make the suite flaky for no gain.
  const bodyHtml = body[1].replace(/<script\b[\s\S]*?<\/script>/gi, '');
  return { title, bodyHtml };
}

/** Every id main.ts looks up as `$('#id')`, and the subset that must be in the markup. */
export function collectQueriedIds(): { all: string[]; required: string[] } {
  const src = readFileSync(MAIN_TS_PATH, 'utf8');
  const all = Array.from(new Set(
    Array.from(src.matchAll(/\$\(\s*'#([A-Za-z0-9_-]+)'\s*\)/g)).map((m) => m[1]),
  )).sort();
  const runtime = new Set(RUNTIME_CREATED_IDS);
  return { all, required: all.filter((id) => !runtime.has(id)) };
}

// ---------------------------------------------------------------------------
// recorded side effects
// ---------------------------------------------------------------------------

export interface RecordedPost { payload: any; transfer: unknown[] }

/** Controllable stand-in for `Worker`; instances are kept per app load. */
export class FakeWorker {
  readonly url: string;
  readonly options: WorkerOptions | undefined;
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  readonly posts: RecordedPost[] = [];
  private readonly listeners = new Map<string, Set<(e: any) => void>>();

  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = String(url);
    this.options = options;
  }

  postMessage(payload: any, transfer?: unknown): void {
    this.posts.push({ payload, transfer: transfer ?? [] });
  }

  terminate(): void { this.terminated = true; }

  addEventListener(type: string, fn: (e: any) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(type: string, fn: (e: any) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(event: { type: string }): boolean {
    for (const fn of Array.from(this.listeners.get(event.type) ?? [])) fn(event);
    return true;
  }

  /** Deliver a worker→page message. Fires `onmessage` then any listeners. */
  deliver(data: any): void {
    const event = new MessageEvent('message', { data });
    this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  /** Simulate a crashed worker (main.ts latches `workerDead` off onerror). */
  crash(message = 'fake worker crashed'): void {
    const event = new ErrorEvent('error', { message });
    this.onerror?.(event);
    this.dispatchEvent(event);
  }

  /** Simulate an undeserializable message. */
  deserializationFailure(err: unknown = new Error('could not be deserialized')): void {
    const event = new MessageEvent('messageerror', { data: err });
    this.onmessageerror?.(event);
    this.dispatchEvent(event);
  }

  /** Payloads of a given type, in send order. */
  payloadsOfType(type: string): any[] {
    return this.posts.map((p) => p.payload).filter((m) => m?.type === type);
  }
}

export interface AppStats {
  worker: { urls: string[]; options: Array<WorkerOptions | undefined> };
  /** putImageData / getImageData counts, per canvas id and in total. */
  canvas: {
    contexts: number;
    getContextCalls: string[];
    putImageData: number;
    getImageData: number;
    createImageData: number;
    toBlob: number;
    toDataURL: number;
    perCanvas: Record<string, number>;
  };
  objectUrls: { created: string[]; revoked: string[]; revokedWithoutCreate: string[] };
  raf: { requested: number; cancelled: number; flushed: number };
  /** window.setInterval bookkeeping — the app's three long-lived timers. */
  timers: { created: number; live: number };
  /** window.toast messages (main.ts wraps whatever the shell installed). */
  toasts: { message: string; error: boolean }[];
  /** window.showView ids, from the harness's shell-boundary stub. */
  views: string[];
  /** createImageBitmap calls + the last size it reported. */
  imageBitmaps: { calls: number; last: { width: number; height: number } | null };
  /** caches.open() buckets the app probed. */
  cacheOpens: string[];
}

function freshStats(): AppStats {
  return {
    worker: { urls: [], options: [] },
    canvas: {
      contexts: 0, getContextCalls: [], putImageData: 0, getImageData: 0,
      createImageData: 0, toBlob: 0, toDataURL: 0, perCanvas: {},
    },
    objectUrls: { created: [], revoked: [], revokedWithoutCreate: [] },
    raf: { requested: 0, cancelled: 0, flushed: 0 },
    timers: { created: 0, live: 0 },
    toasts: [],
    views: [],
    imageBitmaps: { calls: 0, last: null },
    cacheOpens: [],
  };
}

// ---------------------------------------------------------------------------
// global install / restore
// ---------------------------------------------------------------------------

type AnyObj = Record<string, any>;
const g = globalThis as unknown as AnyObj;

interface RestoreEntry { obj: AnyObj; key: string; had: boolean; value: any }

/**
 * Per-LOAD restore stack. Deliberately not module-global: a stale app's
 * teardown() must never unwind the stubs a newer app installed.
 */
function makeEnv() {
  const entries: RestoreEntry[] = [];
  return {
    /** Set obj[key] and remember the previous value (or its absence). */
    define(obj: AnyObj, key: string, value: unknown): void {
      entries.push({ obj, key, had: key in obj, value: obj[key] });
      obj[key] = value;
    },
    /** Undo every define(), in reverse order. Safe to call twice. */
    restore(): void {
      while (entries.length) {
        const e = entries.pop()!;
        if (e.had) e.obj[e.key] = e.value;
        else delete e.obj[e.key];
      }
    },
    get depth(): number { return entries.length; },
  };
}

type Env = ReturnType<typeof makeEnv>;

// ---------------------------------------------------------------------------
// stubs
// ---------------------------------------------------------------------------

function installWorker(env: Env, stats: AppStats): FakeWorker[] {
  const workers: FakeWorker[] = [];
  env.define(g, 'Worker', function WorkerFake(this: unknown, url: string | URL, options?: WorkerOptions) {
    const w = new FakeWorker(url, options);
    workers.push(w);
    stats.worker.urls.push(w.url);
    stats.worker.options.push(options);
    return w;
  } as unknown as AnyObj['Worker']);
  return workers;
}

function installObjectUrls(env: Env, stats: AppStats): void {
  let n = 0;
  // In Vitest's jsdom env globalThis.URL IS window.URL; patch either anyway so
  // the stub holds if that ever changes.
  const targets = [g.URL as unknown as AnyObj, g.window.URL as unknown as AnyObj];
  const create = (): string => {
    const url = `blob:fake/${++n}`;
    stats.objectUrls.created.push(url);
    return url;
  };
  const revoke = (u: string): void => {
    stats.objectUrls.revoked.push(u);
    if (!stats.objectUrls.created.includes(u)) stats.objectUrls.revokedWithoutCreate.push(u);
  };
  for (const obj of targets) {
    // URL is a class, so it must pass a `function` check — an `object` check
    // would skip it silently and the app would throw at the first export.
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) continue;
    env.define(obj, 'createObjectURL', create);
    env.define(obj, 'revokeObjectURL', revoke);
  }
}

function installFrames(env: Env, stats: AppStats): {
  flushFrames: (maxRounds?: number) => number;
  pendingFrames: () => number;
  setAutoFlush: (on: boolean) => void;
} {
  const queue = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  let lastTime = 0;
  let autoScheduled = false;

  const drain = (maxRounds: number): number => {
    let ran = 0;
    for (let round = 0; round < maxRounds; round++) {
      if (queue.size === 0) break;
      const batch = Array.from(queue.values());
      queue.clear();
      for (const cb of batch) {
        lastTime += 1000 / 60; // advance so self-rescheduling animations converge
        ran++;
        stats.raf.flushed++;
        try { cb(lastTime); } catch (e) { /* a test's raf callback throwing is its own problem */ void e; }
      }
    }
    return ran;
  };

  const raf = (cb: FrameRequestCallback): number => {
    stats.raf.requested++;
    const id = ++nextId;
    queue.set(id, cb);
    if (!autoScheduled) {
      autoScheduled = true;
      // Default async behaviour (like the real thing); flushFrames() can run
      // the queue synchronously instead for deterministic tests.
      setTimeout(() => { autoScheduled = false; drain(1); }, 0);
    }
    return id;
  };
  const caf = (id: number): void => {
    stats.raf.cancelled++;
    queue.delete(id);
  };

  env.define(g, 'requestAnimationFrame', raf);
  env.define(g, 'cancelAnimationFrame', caf);
  env.define(g.window as unknown as AnyObj, 'requestAnimationFrame', raf);
  env.define(g.window as unknown as AnyObj, 'cancelAnimationFrame', caf);

  return {
    flushFrames: (maxRounds = 8) => drain(maxRounds),
    pendingFrames: () => queue.size,
    setAutoFlush: (on: boolean) => {
      if (!on) autoScheduled = true; // suppress scheduling until the queue empties
      else autoScheduled = false;
    },
  };
}

function makeFakeContext(canvas: HTMLCanvasElement, stats: AppStats): any {
  const noop = (): void => {};
  const key = canvas.id || `#anon-${stats.canvas.contexts}`;
  const ctx: any = {
    canvas,
    save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
    setTransform: noop, resetTransform: noop, transform: noop,
    clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, arcTo: noop, ellipse: noop, rect: noop,
    bezierCurveTo: noop, quadraticCurveTo: noop,
    fill: noop, stroke: noop, clip: noop,
    setLineDash: noop, getLineDash: () => [],
    drawImage: noop,
    putImageData(_img: any, _x?: number, _y?: number) {
      stats.canvas.putImageData++;
      stats.canvas.perCanvas[key] = (stats.canvas.perCanvas[key] ?? 0) + 1;
    },
    getImageData(x: number, y: number, w: number, h: number) {
      stats.canvas.getImageData++;
      return new ImageData(new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4), w, h);
    },
    createImageData(w: any, h?: number) {
      stats.canvas.createImageData++;
      if (typeof w === 'number') return new ImageData(new Uint8ClampedArray(w * (h ?? 0) * 4), w, h ?? 0);
      const src = w as ImageData;
      return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
    },
    measureText: () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    isPointInPath: () => false,
    // settable no-ops
    fillStyle: '', strokeStyle: '', lineWidth: 1, miterLimit: 10,
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    lineCap: 'butt', lineJoin: 'miter',
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', direction: 'inherit',
    shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0,
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low', filter: 'none',
  };
  return ctx;
}

function installCanvas(env: Env, stats: AppStats): void {
  const proto = g.window.HTMLCanvasElement.prototype as any;
  const contexts = new WeakMap<HTMLCanvasElement, any>();

  env.define(proto, 'getContext', function getContext(this: HTMLCanvasElement, kind: string) {
    stats.canvas.getContextCalls.push(kind);
    if (kind !== '2d') return null;
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = makeFakeContext(this, stats);
      contexts.set(this, ctx);
      stats.canvas.contexts++;
    }
    return ctx;
  });
  env.define(proto, 'toBlob', function toBlob(
    this: HTMLCanvasElement, cb: (b: Blob | null) => void, type = 'image/png',
  ) {
    stats.canvas.toBlob++;
    setTimeout(() => cb(new Blob([new Uint8Array(8)], { type })), 0);
  });
  env.define(proto, 'toDataURL', function toDataURL(this: HTMLCanvasElement, type = 'image/png') {
    stats.canvas.toDataURL++;
    // No AVIF encoder in jsdom → main.ts's avifSupported() resolves false.
    return type === 'image/png' ? 'data:image/png;base64,' : `data:${type};base64,`;
  });

  // jsdom ships no ImageData constructor in some versions.
  if (typeof g.ImageData !== 'function') {
    class ImageDataPoly {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      constructor(a: any, b?: number, c?: number) {
        if (typeof a === 'number') {
          this.width = a; this.height = b ?? 0;
          this.data = new Uint8ClampedArray(this.width * this.height * 4);
        } else {
          this.data = a as Uint8ClampedArray;
          this.width = b ?? Math.floor(this.data.length / 4 / Math.max(1, c ?? 1));
          this.height = c ?? 1;
        }
      }
    }
    env.define(g, 'ImageData', ImageDataPoly);
    env.define(g.window as unknown as AnyObj, 'ImageData', ImageDataPoly);
  }

  // jsdom has no layout, so scrollIntoView is missing entirely.
  if (typeof g.window.Element.prototype.scrollIntoView !== 'function') {
    env.define(g.window.Element.prototype, 'scrollIntoView', function scrollIntoView() {});
  }

  installPointerEvent(env);
}

/**
 * jsdom implements no PointerEvent, so `new window.PointerEvent(...)` throws.
 * Provide the constructor as a MouseEvent subclass carrying the pointer-only
 * fields, which is enough for every listener the app registers: the event
 * still dispatches by type, and `pointerId`/`pointerType`/`pressure` are
 * readable off it.
 */
function installPointerEvent(env: Env): void {
  const win = g.window as unknown as AnyObj;
  if (typeof win.PointerEvent === 'function') return;
  class PointerEventPoly extends win.MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly width: number;
    readonly height: number;
    readonly pressure: number;
    readonly isPrimary: boolean;
    constructor(type: string, init: any = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
      this.width = init.width ?? 1;
      this.height = init.height ?? 1;
      this.pressure = init.pressure ?? (init.buttons ? 0.5 : 0);
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  env.define(win, 'PointerEvent', PointerEventPoly);
  env.define(g, 'PointerEvent', PointerEventPoly);
}

/**
 * Track window.setInterval so a leaked timer (the elapsed clock, the scan
 * overlay, the download-stall reporter) cannot outlive its test, and so a test
 * can assert that the app cleared them.
 */
function installTimers(env: Env, stats: AppStats): { clearAll: () => void } {
  const w = g.window as unknown as AnyObj;
  const realSet = w.setInterval.bind(w) as (fn: (...a: any[]) => void, ms?: number) => number;
  const realClear = w.clearInterval.bind(w) as (id: number) => void;
  const live = new Set<number>();
  const setIntervalTracked = (fn: (...a: any[]) => void, ms?: number): number => {
    const id = realSet(fn, ms);
    live.add(id);
    stats.timers.created++;
    stats.timers.live = live.size;
    return id;
  };
  const clearIntervalTracked = (id: number): void => {
    live.delete(id);
    stats.timers.live = live.size;
    realClear(id);
  };
  env.define(g, 'setInterval', setIntervalTracked);
  env.define(w, 'setInterval', setIntervalTracked);
  env.define(g, 'clearInterval', clearIntervalTracked);
  env.define(w, 'clearInterval', clearIntervalTracked);
  return { clearAll: () => { for (const id of live) realClear(id); live.clear(); stats.timers.live = 0; } };
}

/** Stub the Cache API: main.ts's isModelCached() probes it on every real run. */
function installCaches(env: Env, stats: AppStats): void {
  const store = new Map<string, string[]>();
  env.define(g, 'caches', {
    open: async (bucket: string) => {
      stats.cacheOpens.push(bucket);
      const urls = store.get(bucket) ?? [];
      return {
        keys: async () => urls.map((u) => ({ url: u })),
        match: async () => undefined,
        put: async () => undefined,
        delete: async () => false,
      };
    },
    has: async () => true,
  });
  /** Seed a cache bucket so isModelCached() reports a hit. */
  (g.caches as any).__seed = (bucket: string, urls: string[]): void => { store.set(bucket, urls); };
}

/**
 * Stub createImageBitmap: decodeToImageRef() awaits it, and jsdom lacks it.
 * Per-file dimensions (see imageFile) win over the loadApp default, so two
 * drops in one test can differ in size.
 */
function installImageBitmap(env: Env, stats: AppStats, fallback: { width: number; height: number }): void {
  env.define(g, 'createImageBitmap', async (file?: File) => {
    const width = Number((file as any)?.rmbgWidth) || fallback.width;
    const height = Number((file as any)?.rmbgHeight) || fallback.height;
    stats.imageBitmaps.calls++;
    stats.imageBitmaps.last = { width, height };
    return { width, height, close() {} };
  });
}

/**
 * Stand-ins for the two shell-owned globals main.ts only READS: `toast` (it
 * wraps whatever exists) and `showView` (it calls it on every view change).
 *
 * loadFile / startPreparing / setCompare are deliberately NOT stubbed — main.ts
 * assigns those itself, so their presence after import proves the module ran.
 */
function installShellBoundary(env: Env, stats: AppStats): void {
  const w = g.window as unknown as AnyObj;
  env.define(w, 'toast', (message: string, error?: boolean): void => {
    stats.toasts.push({ message: String(message), error: Boolean(error) });
  });
  env.define(w, 'showView', (id: string): void => { stats.views.push(id); });
}

// ---------------------------------------------------------------------------
// load / teardown
// ---------------------------------------------------------------------------

export interface LoadOptions {
  /** Mute the engine logger (console spy + localStorage 'rmbg-debug' = 'off'). Default true: keeps test output readable. */
  muteLog?: boolean;
  /** Image size reported by the createImageBitmap stub. */
  bitmapSize?: { width: number; height: number };
  /** Replace the real index.html. Only for exercising the harness's own failure paths — never copy the live markup into a fixture. */
  markup?: string;
}

export interface LoadedApp {
  window: Window & typeof globalThis;
  document: Document;
  /** `window.__rmbg.state` — the app's single editing session. */
  state: any;
  /** Every Worker constructed during the import, in order. */
  workers: FakeWorker[];
  /** Recorded side effects (canvas draws, object URLs, frames, toasts, …). */
  stats: AppStats;
  /** window keys that main.ts added or replaced during import. */
  assignedGlobals: string[];
  /** Ids main.ts needs from index.html that the loaded markup is missing. */
  missingIds: string[];
  flushFrames: (maxRounds?: number) => number;
  pendingFrames: () => number;
  /** Turn the async auto-flush off so only explicit flushFrames() runs frames. */
  setAutoFlush: (on: boolean) => void;
  teardown: () => void;
}

/** Every app-owned global, so a reload starts from a clean slate. */
const APP_GLOBALS = [
  '__rmbg', '__rmbgDebug', '__rmbgSplitLock', 'rmbg', 'rmbgTime',
  'loadFile', 'startPreparing', 'setCompare', 'runExport', 'startScan', 'stopScan',
  'toast', 'showView', 'compareMode',
];

let lastApp: LoadedApp | null = null;

/**
 * Build a document from the real index.html, install the environment stubs,
 * then import src/main.ts fresh (vi.resetModules + dynamic import).
 *
 * Throws a diagnostic Error if the import fails: it names the missing ids,
 * because that is the failure mode when index.html is edited underneath us.
 */
export async function loadApp(opts: LoadOptions = {}): Promise<LoadedApp> {
  const { muteLog = true, bitmapSize = { width: 64, height: 48 }, markup } = opts;

  if (lastApp) lastApp.teardown();
  const env = makeEnv();
  const stats = freshStats();

  // --- fresh document -------------------------------------------------------
  const { title, bodyHtml } = readIndexHtml(markup);
  const doc = g.document as Document;
  doc.head.innerHTML = '';
  doc.body.innerHTML = bodyHtml;
  if (title) doc.title = title;
  for (const key of APP_GLOBALS) delete (g.window as unknown as AnyObj)[key];

  // --- environment stubs, all BEFORE the import ----------------------------
  const workers = installWorker(env, stats);
  installObjectUrls(env, stats);
  const frames = installFrames(env, stats);
  installCanvas(env, stats);
  const timers = installTimers(env, stats);
  installCaches(env, stats);
  installImageBitmap(env, stats, bitmapSize);
  installShellBoundary(env, stats);
  if (muteLog) {
    // The engine logger is on by default and main.ts's boot emits several
    // lines. It cannot be muted through the documented switches: main.ts sets
    // `window.__rmbgDebug = true` at module scope, and the engine checks that
    // global before it ever looks at localStorage. So spy on the console for
    // the duration of the import only — restored before any test body runs.
    for (const method of ['log', 'warn', 'info', 'debug', 'table', 'trace'] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
    g.localStorage?.setItem('rmbg-debug', 'off');
  }

  // --- snapshot window keys to detect what main.ts assigned -----------------
  const w = g.window as unknown as AnyObj;
  const before = new Map<string, unknown>();
  for (const k of Object.keys(w)) before.set(k, w[k]);

  // --- import ---------------------------------------------------------------
  vi.resetModules();
  try {
    await import('../src/main');
  } catch (err) {
    const { required } = collectQueriedIds();
    const missing = required.filter((id) => !doc.getElementById(id));
    const detail = missing.length
      ? `missing ids from index.html: ${missing.join(', ')}`
      : 'all queried ids were present — the failure is inside main.ts, see the cause';
    const error = new Error(`importing src/main.ts failed: ${String(err)} — ${detail}`);
    (error as any).cause = err;
    (error as any).missingIds = missing;
    env.restore();
    throw error;
  }

  const state = w.__rmbg?.state;
  if (!state) {
    env.restore();
    throw new Error('src/main.ts imported but window.__rmbg.state is missing — the module never reached its `__rmbg` export');
  }

  const assignedGlobals = Object.keys(w).filter((k) => !before.has(k) || before.get(k) !== w[k]);
  const { required } = collectQueriedIds();

  // Unmute: from here on the test body owns the console.
  if (muteLog) vi.restoreAllMocks();

  let tornDown = false;
  const app: LoadedApp = {
    window: g.window,
    document: doc,
    state,
    workers,
    stats,
    assignedGlobals,
    missingIds: required.filter((id) => !doc.getElementById(id)),
    flushFrames: frames.flushFrames,
    pendingFrames: frames.pendingFrames,
    setAutoFlush: frames.setAutoFlush,
    teardown() {
      if (tornDown) return;
      tornDown = true;
      if (muteLog) vi.restoreAllMocks();
      timers.clearAll();
      for (const worker of workers) worker.terminate();
      if (lastApp === app) lastApp = null;
      doc.body.innerHTML = '';
      // Undo ONLY this load's stubs: env is per-load, so tearing down a stale
      // app cannot unwind the globals a newer app installed.
      env.restore();
      if (muteLog) g.localStorage?.removeItem('rmbg-debug');
    },
  };
  lastApp = app;
  return app;
}

/**
 * A File that realLoadFile() will accept.
 *
 * The dimensions ride along on the File itself, so the createImageBitmap stub
 * can size each drop independently — `imageFile('b.png', 80, 60)` really does
 * decode as 80×60, which is what makes "a mask sized for a different image"
 * testable. Pixels come from the fake canvas, so the image is solid black.
 */
export function imageFile(name = 'shot.png', width = 64, height = 48): File {
  const file = new File([new Uint8Array(Math.max(1, width * height))], name, { type: 'image/png' });
  Object.defineProperty(file, 'rmbgWidth', { value: width, enumerable: false });
  Object.defineProperty(file, 'rmbgHeight', { value: height, enumerable: false });
  return file;
}

/** Alias for LoadedApp, for call sites that read better with a handle name. */
export type AppHandle = LoadedApp;

/** Zero-argument convenience wrapper around loadApp(). */
export function app0(opts?: LoadOptions): Promise<AppHandle> {
  return loadApp(opts);
}

/** Let pending promises / timers settle. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Send a message to the app's worker, as the real worker would. */
export function deliverWorker(worker: FakeWorker, data: unknown): void {
  worker.deliver(data);
}

/** Deliver a reply for a specific request id, matching main.ts's protocol. */
export function replyTo(worker: FakeWorker, id: number, body: Record<string, unknown>): void {
  worker.deliver({ ...body, id });
}

/** The id of the last request the app posted (for `replyTo`). */
export function lastRequestId(worker: FakeWorker): number {
  const last = worker.posts[worker.posts.length - 1];
  if (!last) throw new Error('the app has not posted anything to the worker');
  return last.payload.id;
}

/** Register a global afterEach that tears the app down after every test. */
export function useAppTeardown(): void {
  afterEach(() => {
    lastApp?.teardown();
    lastApp = null;
  });
}
