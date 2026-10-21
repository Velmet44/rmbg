// Offline provenance check for models/manifest.json. Run: npm run validate:manifest
//
// Plain ESM with no dependencies and no network access: it never downloads
// weights, and it does not recompute the checksum (that stays out of band).
// The schema walker covers only the keywords manifest.schema.json uses
// (type, enum, required, properties, items).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

function checkSchema(value, schema, at, errors) {
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.includes(typeOf(value))) {
      errors.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}.${key}: missing required field`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) checkSchema(value[key], sub, `${at}.${key}`, errors);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => checkSchema(item, schema.items, `${at}[${i}]`, errors));
  }
}

/** Reads MODEL_ID and MODEL_REV from packages/app/src/model-config.ts. */
export function readModelConfig(file) {
  const text = readFileSync(file, 'utf8');
  const grab = (name) => {
    const match = text.match(new RegExp(`export const ${name} = '([^']+)'`));
    if (!match) throw new Error(`${name} not found in ${file}`);
    return match[1];
  };
  return { MODEL_ID: grab('MODEL_ID'), MODEL_REV: grab('MODEL_REV') };
}

/** Returns a list of human-readable errors; an empty list means the manifest passes. */
export function validateManifest(manifest, schema, config) {
  const errors = [];
  checkSchema(manifest, schema, 'manifest', errors);
  if (errors.length > 0) return errors;

  const defaults = manifest.artifacts.filter((a) => a.role.startsWith('default-'));
  for (const artifact of defaults) {
    if (artifact.license !== 'MIT') {
      errors.push(`${artifact.modelId}: shipped default must be MIT-licensed, found "${artifact.license}"`);
    }
  }

  const shipped = defaults.find((a) => a.weights === config.MODEL_ID);
  if (!shipped) {
    errors.push(`MODEL_ID "${config.MODEL_ID}" does not match the weights of any shipped default artifact`);
  } else if (shipped.revision !== config.MODEL_REV) {
    errors.push(`revision drift: ${shipped.modelId} is pinned to ${shipped.revision}, but MODEL_REV is ${config.MODEL_REV}`);
  }
  return errors;
}

function main() {
  const dir = new URL('.', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
  const schema = JSON.parse(readFileSync(new URL('manifest.schema.json', dir), 'utf8'));
  const config = readModelConfig(new URL('../packages/app/src/model-config.ts', dir));
  const errors = validateManifest(manifest, schema, config);
  if (errors.length > 0) {
    for (const error of errors) console.error(`manifest: ${error}`);
    process.exit(1);
  }
  console.log(`manifest OK: ${manifest.artifacts.length} artifact(s), shipped ${config.MODEL_ID}@${config.MODEL_REV}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
