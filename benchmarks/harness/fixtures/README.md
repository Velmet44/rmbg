# Fixtures (not in git — bytes ignored, this file tracked)

Stage 0 torture-set coverage target: hair, fur, glasses transparency, fingers,
thin objects, white-on-white, complex background, multiple subjects, small object.

## Current fixtures

| File | Source | Covers |
|---|---|---|
| `rmbg14-example.jpg` | `https://huggingface.co/briaai/RMBG-1.4/resolve/main/example_input.jpg` (reference only, not a model dependency) | giraffes + zebras: thin legs, similar fg/bg tones, complex savanna background, multiple subjects |

## Adding a fixture

1. Drop the file here (jpg/png).
2. Append a row above with source URL + license (only freely usable images).
3. Re-run `npm run measure --workspace @rmbg/harness`.

Ground-truth masks (for IoU/boundary scoring) go here as `<name>.gt.png`
once available; the harness scores them automatically when present.
