import { describe, expect, test } from 'bun:test';
import { progressReporter } from '../src/progress.ts';

describe('progressReporter', () => {
  test('quiet:false writes msg + newline to the sink', () => {
    const written: string[] = [];
    const report = progressReporter(false, (s) => written.push(s));
    report('fetching page 1');
    expect(written).toEqual(['fetching page 1\n']);
  });

  test('quiet:true drops every message — sink never called', () => {
    const written: string[] = [];
    const report = progressReporter(true, (s) => written.push(s));
    report('this should not appear');
    expect(written).toEqual([]);
  });

  test('multiple calls accumulate in order', () => {
    const written: string[] = [];
    const report = progressReporter(false, (s) => written.push(s));
    report('step 1');
    report('step 2');
    expect(written).toEqual(['step 1\n', 'step 2\n']);
  });
});
