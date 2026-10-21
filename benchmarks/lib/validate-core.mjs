// Validation core: DOM-free, no Node built-ins.
//
// Imported by BOTH the Node CLI (benchmarks/lib/validate.mjs, which reads the
// schema off disk) and the browser runner (src/bench/validate-client.ts), so the
// self-check a contributor runs in the page is the same check CI runs on the
// submitted file. One implementation of "is this report honest".

import { summarize } from './stats.mjs';

// ---------- schema subset ----------

function typeOk(value, type) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

export function checkSchema(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(value, t))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value.slice(0, 60))} does not match /${schema.pattern}/`);
    }
    if (schema.minLength && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((v, i) => checkSchema(schema.items, v, `${path}[${i}]`, errors));
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required "${key}"`);
    }
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) checkSchema(props[key], v, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`);
      else if (typeof schema.additionalProperties === 'object') checkSchema(schema.additionalProperties, v, `${path}.${key}`, errors);
    }
  }
}

// ---------- privacy ----------

/** Keys that would carry user data, machine identity or raw bytes. */
export const FORBIDDEN_KEYS = new Set([
  'rgb', 'rgba', 'alpha', 'alphamask', 'imagedata', 'maskpng', 'maskdata',
  'dataurl', 'blob', 'base64', 'pixels', 'buffer',
  'filename', 'filepath', 'file', 'files', 'src', 'url', 'uri', 'href',
  'useragent', 'ua', 'hostname', 'username', 'user', 'email', 'machine', 'path',
  'stack', 'stacktrace', 'error', 'errormessage', 'message',
]);

/** Allowed exceptions: generic names whose content is provably safe. */
const KEY_EXCEPTIONS = new Set(['hostlabel']);

const VALUE_RULES = [
  { id: 'url', re: /[a-z][a-z0-9+.-]*:\/\//i, why: 'a URL' },
  { id: 'win-path', re: /^[a-z]:[\\/]/i, why: 'a Windows path' },
  { id: 'unix-path', re: /(^|[\s"'(])\/(?:home|users|root|tmp|var|mnt)\//i, why: 'a Unix path' },
  { id: 'email', re: /[\w.+-]+@[\w-]+\.[\w.]+/, why: 'an email address' },
  { id: 'data-uri', re: /data:image\//i, why: 'embedded image data' },
  { id: 'long-b64', re: /^[A-Za-z0-9+/=]{200,}$/, why: 'base64-shaped payload' },
];

const MAX_STRING = 300;

export function scanPrivacy(value, path = '$', errors = []) {
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) {
      errors.push(`${path}: string longer than ${MAX_STRING} chars (${value.length}) — looks like embedded data`);
    }
    for (const rule of VALUE_RULES) {
      if (rule.re.test(value)) errors.push(`${path}: contains ${rule.why}`);
    }
    return errors;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanPrivacy(v, `${path}[${i}]`, errors));
    return errors;
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase()) && !KEY_EXCEPTIONS.has(key.toLowerCase())) {
        errors.push(`${path}.${key}: forbidden key (may carry user data or machine identity)`);
      }
      scanPrivacy(v, `${path}.${key}`, errors);
    }
  }
  return errors;
}

// ---------- integrity ----------

/**
 * `stats` is DERIVED from `samples`, so recompute it. A report whose summary was
 * edited by hand, or written by a buggy recorder, is rejected rather than
 * published as a measurement.
 */
export function checkIntegrity(report) {
  const errors = [];
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  const ids = new Set();
  for (const c of cases) {
    const at = `cases[${c.id ?? '?'}]`;
    if (ids.has(c.id)) errors.push(`${at}: duplicate case id`);
    ids.add(c.id);
    if (c.skipped && c.failed) errors.push(`${at}: cannot be both skipped and failed`);
    if (c.skipReason && !c.skipped) errors.push(`${at}: has skipReason but is not skipped`);
    if (c.failReason && !c.failed) errors.push(`${at}: has failReason but is not failed`);
    for (const m of c.measurements ?? []) {
      const mat = `${at}.${m.name}`;
      const hasSamples = Array.isArray(m.samples) && m.samples.length > 0;
      if (!hasSamples && (m.value === null || m.value === undefined)) {
        errors.push(`${mat}: neither samples nor value — an unmeasured measurement is not a measurement`);
      }
      if (hasSamples && !m.stats) errors.push(`${mat}: samples present but stats missing`);
      if (hasSamples && m.stats) {
        const recomputed = summarize(m.samples);
        for (const key of ['n', 'min', 'median', 'max', 'iqr', 'mean', 'stdev']) {
          if (recomputed[key] !== m.stats[key]) {
            errors.push(`${mat}: stats.${key} = ${m.stats[key]} but samples say ${recomputed[key]}`);
          }
        }
        if ((recomputed.p95 ?? null) !== (m.stats.p95 ?? null)) {
          errors.push(`${mat}: stats.p95 = ${m.stats.p95} but samples say ${recomputed.p95}`);
        }
      }
    }
  }
  if (report?.run?.abortedReason && report?.run?.completed) {
    errors.push('run: has an abort reason but is marked completed');
  }
  if (report?.privacy?.forbiddenFieldsChecked === false) {
    errors.push('privacy: report was not scanned for forbidden fields');
  }
  return errors;
}

/** Full validation against a schema. Returns { ok, errors }. */
export function validateReportAgainstSchema(report, schema) {
  const errors = [];
  checkSchema(schema, report, '$', errors);
  if (!errors.length) {
    errors.push(...checkIntegrity(report));
    errors.push(...scanPrivacy(report));
  }
  return { ok: errors.length === 0, errors };
}