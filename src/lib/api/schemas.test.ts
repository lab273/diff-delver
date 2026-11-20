import { describe, expect, it } from 'vitest';
import { AssignRequestSchema, MarkReviewedRequestSchema } from './schemas.ts';

describe('the requests that change a diff', () => {
	it('carry the version the page shows, and are refused without it', () => {
		const tick = {
			target: { kind: 'slice', group: { kind: 'section', section: 'auth' }, path: 'src/a.ts' },
			reviewed: true,
			view: 'sections'
		};
		expect(MarkReviewedRequestSchema.safeParse(tick).success).toBe(false);
		expect(MarkReviewedRequestSchema.safeParse({ ...tick, version: 0 }).success).toBe(false);
		expect(MarkReviewedRequestSchema.parse({ ...tick, version: 2 })).toMatchObject({
			version: 2,
			target: { group: { section: 'auth' }, path: 'src/a.ts' }
		});
		expect(AssignRequestSchema.safeParse({ items: [] }).success).toBe(false);
		expect(
			AssignRequestSchema.parse({ version: 1, items: [{ file: 'src/a.ts', lines: 'file' }] })
		).toEqual({ version: 1, items: [{ file: 'src/a.ts', lines: 'file' }] });
	});
});
