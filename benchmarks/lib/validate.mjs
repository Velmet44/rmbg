// CLI validator: reads the schema off disk and validates report files.
//
//   node benchmarks/lib/validate.mjs <report.json...>
//
// All of the logic lives in validate-core.mjs so the browser can run the exact
// same check on the report it is about to hand to the user.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReportAgainstSchema } from './validate-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(here, 'report.schema.json');

export async function loadSchema() {
  return JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
}

export async function validateReport(report, schema = null) {
  const s = schema ?? (await loadSchema());
  return validateReportAgainstSchema(report, s);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;

if (invokedDirectly) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node benchmarks/lib/validate.mjs <report.json...>');
    process.exit(2);
  }
  const schema = await loadSchema();
  let failed = 0;
  for (const f of files) {
    let report;
    try {
      report = JSON.parse(await readFile(f, 'utf8'));
    } catch (e) {
      console.error(`✗ ${f}: not JSON — ${e.message}`);
      failed++;
      continue;
    }
    const { ok, errors } = await validateReport(report, schema);
    if (ok) {
      const m = report.cases.reduce((t, c) => t + c.measurements.length, 0);
      console.log(`✓ ${f} — ${report.cases.length} cases, ${m} measurements, ${report.run.mode}, ${report.run.completed ? 'complete' : 'partial'}`);
    } else {
      failed++;
      console.error(`✗ ${f} — ${errors.length} problem(s):`);
      for (const e of errors.slice(0, 25)) console.error(`    ${e}`);
      if (errors.length > 25) console.error(`    … and ${errors.length - 25} more`);
    }
  }
  process.exit(failed ? 1 : 0);
}