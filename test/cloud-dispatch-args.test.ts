import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for #1106: --cloud dispatch drops --task.
 * runCloudDispatch in cloud-dispatch.ts builds trigger_data from
 * {source, cloud, model, provider, effort} but never serializes
 * options.task, so cloud runs execute agent defaults instead of the
 * dispatched work. The fix includes task (plus timeout/skills if present)
 * in trigger_data.
 *
 * This is a source-contract test: we read the built JS and verify that
 * trigger_data contains the critical fields.
 */
describe('runCloudDispatch trigger_data includes task/timeout/skills (#1106)', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'cloud-dispatch.ts'),
    'utf8'
  );

  // Extract the trigger_data object definition
  const triggerDataMatch = source.match(/trigger_data:\s*\{[^}]+\}/s);
  const triggerData = triggerDataMatch?.[0] ?? '';

  it('includes task in trigger_data', () => {
    expect(triggerData).toMatch(/task:\s*options\.task/);
  });

  it('includes timeout in trigger_data', () => {
    expect(triggerData).toMatch(/timeout:\s*options\.timeout/);
  });

  it('includes skills in trigger_data', () => {
    expect(triggerData).toMatch(/skills:\s*options\.skills/);
  });

  it('includes all expected fields in trigger_data', () => {
    // Verify the complete set of required fields
    expect(triggerData).toMatch(/source:/);
    expect(triggerData).toMatch(/cloud:/);
    expect(triggerData).toMatch(/model:\s*options\.model/);
    expect(triggerData).toMatch(/provider:\s*options\.provider/);
    expect(triggerData).toMatch(/effort:\s*options\.effort/);
    expect(triggerData).toMatch(/task:\s*options\.task/);
    expect(triggerData).toMatch(/timeout:\s*options\.timeout/);
    expect(triggerData).toMatch(/skills:\s*options\.skills/);
  });
});
