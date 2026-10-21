import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateManifest, readModelConfig } from './validate-manifest.mjs';

const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('./manifest.schema.json', import.meta.url), 'utf8'));
const config = readModelConfig(new URL('../packages/app/src/model-config.ts', import.meta.url));
const clone = (value) => structuredClone(value);
const fast = (m) => m.artifacts.find((a) => a.role === 'default-fast');
const byom = (m) => m.artifacts.find((a) => a.role === 'byom-only');

test('manifest validation accepts valid data and rejects malformed, non-MIT default and drifted data', () => {
  assert.deepEqual(validateManifest(manifest, schema, config), []);

  const malformed = clone(manifest);
  delete fast(malformed).revision;
  malformed.artifacts[0].tier = 'bogus';
  const malformedErrors = validateManifest(malformed, schema, config);
  assert.match(malformedErrors.join('\n'), /revision: missing required field/);
  assert.match(malformedErrors.join('\n'), /tier: "bogus" is not one of/);

  const nonMit = clone(manifest);
  fast(nonMit).license = 'OTHER (non-commercial)';
  assert.match(validateManifest(nonMit, schema, config).join('\n'), /shipped default must be MIT-licensed/);

  const byomAsDefault = clone(manifest);
  byom(byomAsDefault).role = 'default-quality';
  assert.match(validateManifest(byomAsDefault, schema, config).join('\n'), /shipped default must be MIT-licensed/);

  const revisionDrift = clone(manifest);
  fast(revisionDrift).revision = '0000000000000000000000000000000000000000';
  assert.match(validateManifest(revisionDrift, schema, config).join('\n'), /revision drift/);

  const idDrift = { ...config, MODEL_ID: 'studioludens/birefnet-lite-1024' };
  assert.match(validateManifest(manifest, schema, idDrift).join('\n'), /does not match the weights of any shipped default/);

  const byomAsShipped = { ...config, MODEL_ID: byom(manifest).weights };
  assert.match(validateManifest(manifest, schema, byomAsShipped).join('\n'), /does not match the weights of any shipped default/);
});
