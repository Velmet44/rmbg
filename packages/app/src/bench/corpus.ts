// The corpus: what is measured for quality, at which sizes, and — stated
// explicitly — what is NOT covered.
//
// Coverage is reported as data, not prose. `corpusCoverage()` returns the SPEC
// §9 case list with a verdict per case, and the quality suite writes it into
// the report. A reader can then see which claims rest on measurement and which
// rest on somebody looking at a mask once.

import type { Mode } from './types';
import {
  synthDisc, synthFur, synthLowContrast, synthSmallObject, synthSoftAlpha,
  synthThinBars, synthTwoSubjects, type Synthetic,
} from './synth';

export type CorpusCategory =
  | 'hair' | 'fur' | 'glasses-transparency' | 'fingers' | 'thin-object'
  | 'similar-fg-bg' | 'complex-background' | 'multiple-subjects' | 'small-object'
  | 'soft-alpha' | 'smooth-boundary';

export interface CorpusCase {
  /** Stable public id. Appears in reports, so it must never encode a path. */
  id: string;
  kind: 'synthetic' | 'photo';
  categories: CorpusCategory[];
  width: number;
  height: number;
  /** Present only for synthetic cases: exact-by-construction ground truth. */
  make: () => Synthetic;
  /** Reference alpha for scoring. Synthetic cases bring their own; a photo
   *  case without one has no automatic score, ever. */
  hasGroundTruth: boolean;
  note?: string;
}

function S(
  id: string, categories: CorpusCategory[], width: number, height: number,
  make: () => Synthetic, note?: string,
): CorpusCase {
  return { id, kind: 'synthetic', categories, width, height, make, hasGroundTruth: true, note };
}

/**
 * Photo corpus: INTENTIONALLY EMPTY.
 *
 * SPEC §9 asks for a fixed torture set over nine photographic conditions with
 * ground-truth masks and IoU / boundary-F scoring. That set does not exist in
 * this repository, and inventing entries for it would be worse than the gap:
 * a fixture whose provenance, licence and mask annotation nobody verified is
 * not evidence, and it would be published next to real numbers.
 *
 * Adding one is a documented, reviewable job: drop the file, record its source
 * URL, licence and SHA-256, and attach an annotated mask — then add the entry
 * here with `hasGroundTruth: true`. See benchmarks/corpus/README.md.
 */
export const PHOTO_CORPUS: CorpusCase[] = [];

/** Cases measured for quality, by mode. */
export function corpusForMode(mode: Mode): CorpusCase[] {
  const base: CorpusCase[] = [
    S('disc', ['smooth-boundary', 'complex-background'], 640, 480, () => synthDisc(640, 480)),
    S('thin-bars', ['thin-object'], 640, 480, () => synthThinBars(640, 480),
      'Sub-pixel structure after the 512px working-res downsample: the case that decides whether thin objects survive at all.'),
    S('fur', ['fur'], 640, 480, () => synthFur(640, 480),
      'Hair/fur stand-in. Synthetic, so it validates the partial-alpha path — NOT photographic fur quality.'),
    S('low-contrast', ['similar-fg-bg'], 640, 480, () => synthLowContrast(640, 480)),
    S('two-subjects', ['multiple-subjects'], 640, 480, () => synthTwoSubjects(640, 480)),
    S('soft-alpha', ['soft-alpha'], 640, 480, () => synthSoftAlpha(640, 480),
      'The only case whose reference alpha is genuinely soft, so it is the only one where alphaMAE means anything.'),
    S('small-object', ['small-object'], 640, 480, () => synthSmallObject(640, 480)),
    S('disc-1024', ['smooth-boundary'], 1024, 768, () => synthDisc(1024, 768, 'disc-1024')),
  ];
  if (mode === 'stress') {
    base.push(
      S('fur-1600', ['fur', 'thin-object'], 1600, 1200, () => synthFur(1600, 1200, 'fur-1600')),
      S('thin-bars-2048', ['thin-object'], 2048, 1536, () => synthThinBars(2048, 1536, 'thin-bars-2048')),
    );
  }
  return base.concat(PHOTO_CORPUS);
}

/** Synthetic pixels -> a real encoded file, for the decode suite. The corpus
 *  generator produces RGB; the app ingests encoded bytes, so the ingest
 *  benchmark must too rather than timing a synthetic shortcut. */
export async function syntheticToBlob(syn: Synthetic, mime: string): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = syn.width; canvas.height = syn.height;
  const ctx = canvas.getContext('2d')!;
  const id = ctx.createImageData(syn.width, syn.height);
  for (let i = 0; i < syn.width * syn.height; i++) {
    id.data[i * 4] = syn.rgb[i * 3];
    id.data[i * 4 + 1] = syn.rgb[i * 3 + 1];
    id.data[i * 4 + 2] = syn.rgb[i * 3 + 2];
    id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return new Promise((res) => canvas.toBlob(res, mime));
}

export interface CoverageVerdict {
  category: CorpusCategory;
  automated: boolean;
  why: string;
}

/** SPEC §9's list, each with the honest verdict. Written into every report as
 *  `quality.coverage`, so "what is not measured" travels with the numbers. */
export function corpusCoverage(cases: CorpusCase[]): CoverageVerdict[] {
  const covered = new Set(cases.flatMap((c) => c.categories));
  const why: Record<CorpusCategory, string> = {
    'hair': 'Synthetic strands validate the partial-alpha path. Photographic hair (flyaways, motion blur) needs a photo corpus with annotated masks.',
    'fur': 'Same as hair: a synthetic stand-in only.',
    'glasses-transparency': 'No case. Transparency through glass is where the float-alpha design should pay off, and nothing here measures it.',
    'fingers': 'No case. Fingers are the classic failure at 512px working resolution.',
    'thin-object': 'Covered synthetically.',
    'similar-fg-bg': 'Covered synthetically.',
    'complex-background': 'Partially: the synthetic background is a gradient with noise, not clutter.',
    'multiple-subjects': 'Covered synthetically.',
    'small-object': 'Covered synthetically.',
    'soft-alpha': 'Covered synthetically.',
    'smooth-boundary': 'Covered synthetically.',
  };
  return (Object.keys(why) as CorpusCategory[]).map((category) => ({
    category,
    automated: covered.has(category),
    why: why[category],
  }));
}