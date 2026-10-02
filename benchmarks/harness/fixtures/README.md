# Fixtures (not in git — bytes ignored, this file tracked)

Stage 0 torture-set coverage target: hair, fur, glasses transparency, fingers,
thin objects, white-on-white, complex background, multiple subjects, small object.

**Not achieved.** There is exactly one fixture below. It does not exist in a
fresh clone either — the image bytes are gitignored, so a contributor must supply
one by hand before `npm run measure` will do anything (it hard-exits otherwise).

## Current fixtures

| File | Source | Covers |
|---|---|---|
| `rmbg14-example.jpg` | `https://huggingface.co/briaai/RMBG-1.4/resolve/main/example_input.jpg` (reference only, not a model dependency) | giraffes + zebras: thin legs, similar fg/bg tones, complex savanna background, multiple subjects |

Missing from the target above: hair, fur, glasses transparency, fingers, thin
objects, white-on-white, small object.

## Adding a fixture

1. Drop the file here (jpg/png).
2. Append a row above with source URL + license (only freely usable images).
3. Re-run `npm run measure --workspace @rmbg/harness`.

## What the harness actually produces

Per fixture, per run:

- a mask PNG (`results/<model>/<device>/<fixture>.mask.png`) for a human to look at
- per-phase timings in `summary.json` — download, cold init, cold/warm inference

That is all. **There is no automatic quality scoring**: no mask IoU, no boundary
F-measure, no rating sheet, no pass/fail bar. Nothing reads `<name>.gt.png`,
because no ground-truth mask exists in this repo, so the SPEC §9 scoring plan
("mask IoU / boundary F-measure where ground truth exists, plus blind human
rating") is **not implemented**. Every quality claim in this project currently
rests on someone looking at a mask once.

The harness has also never completed a run: all three committed `summary.json`
files are failure records with `"runs": []`. See
[`benchmarks/GATE.md`](../../GATE.md).
