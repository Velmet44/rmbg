// Report shapes. The JSON Schema in benchmarks/lib/report.schema.json is the
// validation contract; these types are the writer's view of the same thing and
// are checked against it by `npm run bench:validate`.
//
// Anything in here that could carry user data is deliberately absent: no image
// bytes, no file names, no URLs, no raw error text. See SCHEMA privacy section.

export const SCHEMA_VERSION = 'rmbg-bench/1';
/** Bump on any change to case ids, measurement names or units. */
export const SUITE_VERSION = '1.0.0';

export type Mode = 'quick' | 'full' | 'stress';

export type Unit =
  | 'ms' | 'B' | 'px' | 'count' | 'ratio' | 'score' | 'frames' | 'fps' | 'MPix/s' | 'MB/s';

export interface Stats {
  n: number;
  min: number;
  median: number;
  p95: number | null;
  max: number;
  iqr: number;
  mean: number;
  stdev: number;
}

export interface Measurement {
  name: string;
  unit: Unit;
  warmups?: number;
  samples?: number[] | null;
  value?: number | null;
  stats?: Stats | null;
  method?: string | null;
}

export interface CaseResult {
  id: string;
  suite: string;
  case: string;
  labels?: Record<string, string | number | boolean | null>;
  skipped?: boolean;
  skipReason?: string | null;
  failed?: boolean;
  failReason?: string | null;
  measurements: Measurement[];
  derived?: Record<string, number | boolean | string | null>;
  notes?: string[];
}

export interface Report {
  schemaVersion: string;
  suiteVersion: string;
  app: {
    commit: string | null;
    buildKind: string;
    model: { id: string; revision: string };
    runtime?: { id: string; version?: string | null };
    engine: { workingLongSide: number };
  };
  run: {
    id: string;
    startedAt: string;
    mode: Mode;
    completed: boolean;
    abortedReason?: string | null;
    durationMs: number;
    suites: string[];
    hostLabel?: string | null;
  };
  environment: {
    browser: { name: string; version: string | null };
    os: { name: string; version: string | null };
    arch?: string | null;
    deviceMemoryGbBucket?: string | null;
    hardwareConcurrency?: number | null;
    hardwareConcurrencyBucket?: string | null;
    devicePixelRatio?: number | null;
    viewport?: { width: number; height: number };
    crossOriginIsolated?: boolean | null;
    isSecureContext?: boolean | null;
  };
  hardware?: {
    gpu?: { available: boolean; software: boolean; adapter: string | null; maxTextureDimension2D?: number | null; maxBufferSize?: number | null };
    jsHeapLimitBytes?: number | null;
    deviceMemoryGb?: number | null;
  } | null;
  capabilities: Record<string, boolean | number | string | null>;
  cases: CaseResult[];
  notes?: string[];
  privacy: {
    includeHardwareDetails: boolean;
    forbiddenFieldsChecked: boolean;
    toolkit: string;
  };
}

/** Grouping keys attached to a case. Never user data. */
export type Labels = Record<string, string | number | boolean | null>;