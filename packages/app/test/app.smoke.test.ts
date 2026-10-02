// Baseline smoke tests for the app shell.
//
// Scope: only things that are true of the CURRENT main.ts. No assertion here
// should encode a bug that is about to be fixed — regression tests for those
// live in their own file so a failing one points at the fix, not at the floor.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  click, collectQueriedIds, deliverWorker, imageFile, loadApp, readIndexHtml, replyTo,
  RUNTIME_CREATED_IDS, tick, useAppTeardown, type LoadedApp,
} from './harness';

let app: LoadedApp;

beforeEach(async () => {
  app = await loadApp();
});
// Tears down whichever app was loaded last, and restores every global it stubbed.
useAppTeardown();

describe('boot', () => {
  it('imports src/main.ts against the real index.html markup without throwing', () => {
    // The import itself is the assertion: loadApp() resolves only if every
    // module-scope statement ran, and main.ts dereferences ~78 ids on load.
    expect(app.state).toBeTruthy();
    expect(app.missingIds).toEqual([]);
  });

  it('exposes the single editing session on window.__rmbg.state', () => {
    const s = app.state;
    expect(s.image).toBeNull();
    expect(s.previewURL).toBeNull();
    expect(s.mask).toBeNull();
    expect(s.removeBg).toBe(false);
    expect(s.backend).toBe('…'); // unknown until the worker reports
    expect(s.log.canUndo).toBe(false);
    expect(s.log.canRedo).toBe(false);
    expect(s.log.depth).toBe(0);
  });

  it('publishes the document title from index.html', () => {
    const { title } = readIndexHtml();
    expect(title).not.toBe('');
    expect(app.document.title).toBe(title);
  });

  it('constructs exactly one inference worker and prefetches with an init message', () => {
    expect(app.workers).toHaveLength(1);
    const [worker] = app.workers;
    // main.ts spawns the worker at module scope with a module-typed URL.
    expect(worker.url).toContain('infer-worker.ts');
    expect(worker.options).toEqual({ type: 'module' });

    const inits = worker.payloadsOfType('init');
    expect(inits).toHaveLength(1);
    expect(inits[0]).toEqual({ type: 'init', id: 1 });
  });
});

describe('markup contract', () => {
  it('has every id main.ts queries, except the ones it creates at runtime', () => {
    const { all, required } = collectQueriedIds();
    expect(all.length).toBeGreaterThan(50); // the scan actually found something
    expect(required.length).toBe(all.length - RUNTIME_CREATED_IDS.length);

    const missing = required.filter((id) => app.document.getElementById(id) === null);
    expect(missing).toEqual([]);
  });

  it('leaves undo and redo inert while there is nothing to undo', () => {
    const undo = app.document.querySelector('#btnUndo') as HTMLButtonElement;
    const redo = app.document.querySelector('#btnRedo') as HTMLButtonElement;
    expect(undo).toBeTruthy();
    expect(redo).toBeTruthy();

    // KNOWN GAP (not asserted as an invariant, see the report): the markup ships
    // neither button with `disabled`, and main.ts only ever calls
    // syncUndoRedo() from renderDisplay() — which early-returns while no image is
    // loaded — so on a fresh boot both read as ENABLED. They are harmless: the
    // handlers return before touching the log when there is no mask.
    click('#btnUndo');
    click('#btnRedo');
    expect(app.state.log.canUndo).toBe(false);
    expect(app.state.log.canRedo).toBe(false);
    expect(app.state.log.depth).toBe(0);
  });

  it('binds the editor actions main.ts rebinds from the mock shell', () => {
    // onclick is an IDL attribute, so "is it bound" is a function check.
    const bound: string[] = [
      '#btnUndo', '#btnRedo', '#btnDoExport', '#btnPrepCancel', '#btnBatch',
      '#btnBatchAdd', '#btnBatchExport', '#btnToBatch', '#confirmOk', '#btnSendReport',
    ];
    for (const sel of bound) {
      const el = app.document.querySelector(sel) as HTMLElement | null;
      expect(el, `${sel} must exist`).toBeTruthy();
      expect(typeof (el as any).onclick, `${sel}.onclick must be bound`).toBe('function');
    }
  });

  it('wires the addEventListener-bound actions without an onclick property', () => {
    // #btnRecompute is bound with addEventListener, so `onclick` stays null —
    // a dispatched click is what proves it is live.
    const el = app.document.querySelector('#btnRecompute') as HTMLElement | null;
    expect(el).toBeTruthy();
    expect(el!.onclick).toBeNull();
    expect(() => click('#btnRecompute')).not.toThrow(); // rerun() with no image returns early
    expect(app.state.image).toBeNull();
  });
});

describe('shell boundary', () => {
  it('installs the window hooks the inline shell calls into', () => {
    const w = app.window as unknown as Record<string, unknown>;
    for (const name of ['loadFile', 'startPreparing', 'setCompare', 'showView', 'startScan', 'stopScan']) {
      expect(typeof w[name], `window.${name}`).toBe('function');
    }
    expect(typeof w.rmbg).toBe('function');     // diagnostics dump
    expect(typeof w.rmbgTime).toBe('function'); // ms since page load
  });

  it('overrides the shell-owned entry points with the real ones', () => {
    // loadFile / startPreparing / setCompare / startScan / stopScan are assigned
    // by main.ts itself; the harness pre-stubs none of them, so seeing them in
    // the diff proves the module (not the harness) put them there.
    for (const name of ['loadFile', 'startPreparing', 'setCompare', 'startScan', 'stopScan']) {
      expect(app.assignedGlobals, `main.ts must assign window.${name}`).toContain(name);
    }
    // toast is wrapped, not replaced: it exists before the import (shell stub).
    expect(app.assignedGlobals).toContain('toast');
    // showView is shell-owned and only called by main.ts.
    expect(app.assignedGlobals).not.toContain('showView');
  });
});

describe('harness surface', () => {
  it('records toasts raised through the wrapped shell hook', () => {
    const w = app.window as unknown as Record<string, any>;
    w.toast('from a test');
    expect(app.stats.toasts).toEqual([{ message: 'from a test', error: false }]);
    expect(app.workers[0].posts).toHaveLength(1);
  });

  it('flips to a completely fresh app on a second loadApp()', async () => {
    const first = app;
    const second = await loadApp();
    expect(second.state).not.toBe(first.state);
    expect(second.workers[0]).not.toBe(first.workers[0]);
    // A fresh module graph means module-scope counters restart too.
    expect(second.workers[0].posts).toHaveLength(1);
    expect(second.stats.canvas.contexts).toBe(0);
  });

  it('restores the globals it replaced on teardown', () => {
    const g = globalThis as any;
    expect(typeof g.Worker).toBe('function'); // the fake is installed right now
    const fakeRaf = g.requestAnimationFrame;
    app.teardown();
    expect(g.Worker).toBeUndefined();
    expect(g.requestAnimationFrame).not.toBe(fakeRaf);
  });

  it('drives requestAnimationFrame deterministically', () => {
    let ran = 0;
    app.window.requestAnimationFrame(() => { ran++; });
    expect(app.pendingFrames()).toBe(1);
    expect(ran).toBe(0); // nothing runs until flushed
    app.flushFrames();
    expect(ran).toBe(1);
    expect(app.pendingFrames()).toBe(0);
  });

  it('clears canvas state between loads', () => {
    // The result canvas is created at runtime and appended to #checker, so a
    // stale one must not survive into the next load.
    expect(app.document.querySelector('#resultCanvas')).toBeNull();
  });

  it('names the ids a broken markup is missing instead of failing opaquely', async () => {
    // This is the failure mode when index.html is edited under us: main.ts
    // dereferences a null element at module scope. The harness must say WHICH
    // ids are gone, not just "something threw".
    const gutted = '<!doctype html><html><head><title>gutted</title></head><body><div id="btnUndo"></div></body></html>';
    const error = await loadApp({ markup: gutted }).then(() => null, (e: any) => e);
    expect(error).toBeTruthy();
    expect(String(error.message)).toMatch(/missing ids from index html|missing ids from index\.html/i);
    expect(error.missingIds).toContain('btnRedo');
    expect(error.missingIds).not.toContain('btnUndo'); // the one id we kept
    expect(error.cause).toBeTruthy(); // the original TypeError is preserved
  });
});

describe('worker round trip', () => {
  it('adopts the backend the worker reports, from the owner of that value', async () => {
    const w = app.window as unknown as Record<string, any>;
    const [worker] = app.workers;
    // The boot prefetch deliberately does NOT write state.backend (an init-time
    // backend can be stale by the time a segmentation runs), so answer the init
    // that ensureReady sent for the real run instead.
    expect(app.state.backend).toBe('…');
    await w.loadFile(imageFile('shot.png'));
    await tick();

    const inits = worker.payloadsOfType('init');
    const latest = inits[inits.length - 1];
    replyTo(worker, latest.id, {
      type: 'ready', backend: 'wasm/fp32', gpu: 'fake gpu', cacheName: 'c', model: 'm',
    });
    await tick();
    expect(app.state.backend).toBe('wasm/fp32');

    // realStart is now waiting on `segment` with the overlay up; do not leave it.
    w.stopScan();
  });

  it('decodes a dropped file through the fake canvas and asks the worker to init', async () => {
    const w = app.window as unknown as Record<string, any>;
    await w.loadFile(imageFile('shot.png'));
    await tick();

    // decodeToImageRef drew into the fake 2D context and read zeros back.
    expect(app.state.image).toMatchObject({ id: 'shot.png', width: 64, height: 48 });
    expect(app.state.previewURL).toMatch(/^blob:fake\//);
    expect(app.state.mask).toBeNull();      // nothing segmented yet
    expect(app.state.removeBg).toBe(false);

    // ensureCanvases/ensureSplit build the nodes main.ts creates at runtime.
    for (const id of ['#resultCanvas', '#splitLC', '#splitRC', '#splitDiv2']) {
      expect(app.document.querySelector(id), id).toBeTruthy();
    }

    // loadFile hands off to startPreparing, which prefetched init on boot and
    // now asks again for the real run.
    expect(app.workers[0].payloadsOfType('init')).toHaveLength(2);
    expect(app.stats.views).toContain('view-preparing');
    expect(app.stats.objectUrls.created.length).toBeGreaterThan(0);
  });

  it('fans a progress event out to the caller that is waiting on it', async () => {
    const w = app.window as unknown as Record<string, any>;
    await w.loadFile(imageFile('shot.png'));
    await tick();

    const [worker] = app.workers;
    const inits = worker.payloadsOfType('init');
    const id = inits[inits.length - 1].id;
    // A percentage may only appear for measured bytes, so this one is real.
    deliverWorker(worker, {
      type: 'progress', id, status: 'progress', file: 'model.onnx', loaded: 1024, total: 4096,
    });
    await tick();

    const pct = app.document.querySelector('#prepPct') as HTMLElement;
    const mb = app.document.querySelector('#prepMB') as HTMLElement;
    expect(pct.textContent).toBe('25%');
    expect(mb.textContent).toContain('KB');
  });

  it('fails every pending request and latches when the worker crashes', async () => {    const [worker] = app.workers;
    await (app.window as unknown as Record<string, any>).loadFile(imageFile());
    await tick();
    worker.crash('boom');
    await tick();
    expect(app.stats.toasts.some((t) => t.error && /crashed/i.test(t.message))).toBe(true);

    // workerDead is latched: a later request rejects immediately rather than
    // being posted to a dead worker (which would hang forever).
    const postedBefore = worker.posts.length;
    await (app.window as unknown as Record<string, any>).startPreparing(false);
    await tick();
    expect(worker.posts.length).toBe(postedBefore);
    expect(app.stats.toasts.filter((t) => /crashed/i.test(t.message)).length).toBeGreaterThan(1);
  });
});
