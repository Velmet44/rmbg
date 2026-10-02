// Single source of truth for the shipped model's identity.
//
// Both the main thread (issue diagnostics, pre-flight cache probe) and the
// worker (adapter construction) import this, so swapping models is a one-line
// change instead of an edit in two files that silently disagree. The weights
// file probe is derived from MODEL_ID for the same reason.
//
// models/manifest.json is the provenance record (revision, license, checksum,
// bytes) and MUST be updated to match these values.

export const MODEL_ID = 'studioludens/birefnet-lite-512';
export const MODEL_REV = '4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7';

/** Matches the weights file of MODEL_ID inside the runtime cache bucket.
 *  Derived, not hand-written: a hardcoded repo string silently kept matching
 *  the previous model after a swap, so the app claimed "not cached" forever. */
export const MODEL_WEIGHTS_RE = new RegExp(
  `${MODEL_ID.split('/').pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\.onnx`,
  'i',
);
