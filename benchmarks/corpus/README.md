# Benchmark corpus

The benchmark suite measures two different things, and this directory is about
the second one.

| What | Where it comes from | Can it be reproduced from a fresh clone? |
|---|---|---|
| **Performance** (how long an operation takes) | measured live on the contributor's machine | Yes — it is re-measured every run |
| **Pipeline correctness** (is the mask geometrically right?) | synthetic cases with ground truth generated from the same parametric definition as the pixels | **Yes, fully** — no downloads, no binaries in git |
| **Cutout quality** (is the cutout good?) | a photo corpus with annotated ground-truth masks | **No — it does not exist** |

## The synthetic corpus

Cases live in `packages/app/src/bench/synth.ts` and the case list in
`corpus.ts`. They are generated in the browser at run time, so there are no
image files, no bytes in git, and nothing to download.

| Case | Covers | What a low score means |
|---|---|---|
| `disc` | smooth boundary, graded background | |
| `thin-bars` | sub-pixel structures after the 512px working-res downsample | |
| `fur` | many thin strands, partial alpha | a synthetic stand-in for fur/hair |
| `low-contrast` | foreground and background within a few levels of each other | |
| `two-subjects` | two separate subjects | |
| `soft-alpha` | a reference that is genuinely soft end to end | the only case where `alphaMAE` means anything |
| `small-object` | a subject occupying ~2.5% of the frame | |
| `disc-1024` | a larger frame, same shape | |

`stress` mode adds `fur-1600` and `thin-bars-2048`.

### What these cases prove, and what they do not

They prove the **mask pipeline** is correct: no transposed axes, no flipped
image, no wrong working-resolution mapping, alpha read from the right channel,
region patches landing inside the box they were given. `orientationOk`,
`dimensionMismatch` and `outsideBoxBitIdentical` are the assertions.

They do **not** measure photographic cutout quality. BiRefNet is trained on
natural photographs and a synthetic disc is out of distribution, so a low IoU on
these cases is information about the *model*, not about this codebase. The
report says so on every quality case (`quality.mask` carries an explicit note),
and this table exists so nobody has to guess.

## The photo corpus — a real gap, not an oversight

SPEC §9 asks for a fixed torture set over nine photographic conditions with
ground-truth masks, scored by IoU and boundary F-measure. That set does not
exist. `PHOTO_CORPUS` in `packages/app/src/bench/corpus.ts` is an empty array
with the reason written next to it.

| SPEC §9 condition | Automated ground truth today |
|---|---|
| thin objects | yes (synthetic) |
| similar fg/bg colours | yes (synthetic) |
| complex background | partly — a gradient with noise, not clutter |
| multiple subjects | yes (synthetic) |
| small objects | yes (synthetic) |
| hair | **no** — synthetic strands only |
| fur | **no** — synthetic strands only |
| fingers | **no** |
| glasses / transparency | **no** |

Every report carries this as data: the `quality.coverage` case lists each
category with an `automated` verdict, so a reader can see the gap from the
numbers rather than trusting a sentence in a README.

### Adding a photo fixture

This is reviewable, documented work. In order:

1. **Choose the image.** Freely usable, or explicitly licensed for
   redistribution. Record the source URL, the licence and the author.
2. **Drop the file** in `benchmarks/harness/fixtures/` — image bytes are
   gitignored, so the *provenance record* is what gets committed.
3. **Annotate a reference mask** at the image's own resolution. Store it beside
   the image. It must be reviewed by a person; an unreviewed auto-generated mask
   is not ground truth.
4. **Record the checksum** of both files.
5. **Add the row** to `benchmarks/harness/fixtures/README.md` with source,
   licence and what the case covers.
6. **Add the entry** to `PHOTO_CORPUS` in `packages/app/src/bench/corpus.ts`
   with `hasGroundTruth: true` and the categories it satisfies.

Until step 3 is done honestly for a case, it stays uncovered — an entry whose
provenance nobody verified would be worse than the gap, because it would sit in
a table next to real numbers.