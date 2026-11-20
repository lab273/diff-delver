import { describe, expect, it } from 'vitest';
import { parseRevision } from './revision.tiny.ts';

describe('parseRevision', () => {
	it('accepts what git can resolve and refuses what it would misread', () => {
		for (const ok of [
			'HEAD',
			'main',
			'refs/heads/x',
			'v1.2^',
			'HEAD~3',
			'HEAD@{1 week ago}',
			'@'
		]) {
			expect(parseRevision(ok).ok, ok).toBe(true);
		}
		const reasons = ['', '-x', 'a..b', ' main', 'a\nb', 'a\u007fb'].map((text) => {
			const result = parseRevision(text);
			return result.ok ? 'ok' : result.error.reason;
		});
		expect(reasons).toEqual([
			'empty',
			'starts-with-dash',
			'has-range',
			'surrounding-space',
			'control-character',
			'control-character'
		]);
	});
});
