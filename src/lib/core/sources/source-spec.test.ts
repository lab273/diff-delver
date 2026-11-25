import { describe, expect, it } from 'vitest';
import {
	describeInvalidSource,
	describeSource,
	formatSourceSpec,
	parseSourceSpec
} from './source-spec.ts';

describe('parseSourceSpec', () => {
	it('reads a pull request’s address, and writes it back in one form', () => {
		const spec = parseSourceSpec('https://github.com/Acme/shop/pull/7/files');
		expect(spec.ok && spec.value.kind).toBe('pull-request');
		if (!spec.ok) return;
		expect(formatSourceSpec(spec.value)).toBe('https://github.com/Acme/shop/pull/7');
		expect(describeSource(spec.value)).toBe('Pull request #7');
	});

	it('reads anything that is not an address as a git source', () => {
		const spec = parseSourceSpec('main...feature');
		expect(spec.ok && spec.value).toEqual({ kind: 'range', from: 'main', to: 'feature' });
	});

	it('never reads an address as a revision', () => {
		const spec = parseSourceSpec('https://example.com/shop/pull/7');
		expect(spec.ok).toBe(false);
		if (spec.ok) return;
		expect(describeInvalidSource(spec.error)).toContain('github.com only');
	});
});
