// Browser-side validation: the SAME code the Node CLI runs, so the "Self-check"
// button a contributor presses is not a softer version of the CI gate.

import schema from '../../../../benchmarks/lib/report.schema.json';
import { validateReportAgainstSchema } from '../../../../benchmarks/lib/validate-core.mjs';
import type { Report } from './types';

export function validateReport(report: Report): { ok: boolean; errors: string[] } {
  return validateReportAgainstSchema(report, schema);
}