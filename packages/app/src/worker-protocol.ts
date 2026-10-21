// The worker wire protocol, in one place.
//
// src/infer-worker.ts speaks it, src/main.ts sends it, and the benchmark runner
// sends it too — so a change to the message shape is a type error in three
// places instead of a silent runtime mismatch in one. Types only: this module
// emits no runtime code.

import type { BBox } from '@rmbg/engine';

export interface InitRequest { type: 'init' }

export interface SegmentRequest {
  type: 'segment';
  imageId: string;
  w: number;
  h: number;
  /** Packed RGB, transferred (its buffer is detached on the receiving side). */
  rgb: ArrayBuffer;
}

export interface RecomputeRequest {
  type: 'recompute';
  imageId: string;
  w: number;
  h: number;
  rgb: ArrayBuffer;
  mw: number;
  mh: number;
  /** Existing full-res alpha, transferred, so only the patched mask comes back. */
  alpha: ArrayBuffer;
  bbox: BBox;
}

export type WorkerRequest = InitRequest | SegmentRequest | RecomputeRequest;

/** Emitted while a request is in flight. `status: 'runtime'` is the app's own
 *  marker for "the pinned CDN runtime is fetching" — it carries no bytes, so it
 *  is a phase label and never a percentage. */
export interface WorkerProgressMessage {
  id: number;
  type: 'progress';
  status: 'initiate' | 'download' | 'progress' | 'done' | 'runtime';
  file: string;
  loaded?: number;
  total?: number;
}

export interface WorkerReadyMessage {
  id: number;
  type: 'ready';
  backend: string | null;
  gpu: string;
  model: string;
  cacheName: string;
}

export interface WorkerMaskMessage {
  id: number;
  type: 'mask';
  w: number;
  h: number;
  /** Float32 alpha, transferred. */
  alpha: ArrayBuffer;
  /** Backend THIS call used — the adapter can fall back from WebGPU to WASM
   *  mid-segment, so the init-time backend is stale by the time a mask exists. */
  backend: string | null;
  gpu: string;
}

export interface WorkerErrorMessage {
  id: number;
  type: 'error';
  message: string;
}

export type WorkerResponse = WorkerProgressMessage | WorkerReadyMessage | WorkerMaskMessage | WorkerErrorMessage;