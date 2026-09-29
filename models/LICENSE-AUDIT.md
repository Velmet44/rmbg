# License audit — Stage 0

Verified 2026-09-29 via the Hugging Face API (`license` tags + model cards).

## Defaults (MIT, shippable)

| Artifact | Weights | Base | License | Evidence |
|---|---|---|---|---|
| `birefnet-lite` (fast) | `studioludens/birefnet-lite-512` rev `4a3c40c3` | `ZhengPeng7/BiRefNet_lite` | MIT | `license:mit` tag on conversion repo (verified 2026-09-29); 512px browser export, fp32 (183 MB) + fp16 (94 MB) |
| `birefnet-512` (quality, GPU-only) | `naddy24/birefnet-512-webgpu` rev `ca02a86c` | `onnx-community/BiRefNet_512x512-ONNX` | MIT | `license:mit` tag + card (verified 2026-09-29); 512px export with empty ScatterND removed; fp16-only (452 MB), no fp32 file |

BiRefNet code + weights are published MIT by the authors (CAAI AIR 2024). The
`onnx-community` conversions are quantised/converted redistributions that retain
`license:mit`. No commercial-use restriction. Commercial use is allowed.

## BYOM / reference only (NOT MIT, never default)

| Artifact | License | Rule |
|---|---|---|
| `rmbg-1.4` (`briaai/RMBG-1.4` rev `2ceba5a5`) | `other`: bria-rmbg-1.4, **non-commercial source-available** | never bundled, never default; user-supplied BYOM only with in-app license notice |

## Policy (binding)

- `models/manifest.json` is the only record of model provenance. No weights in git.
- The harness refuses to measure any artifact whose manifest license is not
  `MIT` unless it is flagged `byom-only`/`reference` (measured locally only,
  never shipped).
- Re-verify on every revision bump: license tag + card text + revision pin.
