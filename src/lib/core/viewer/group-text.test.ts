import { describe, expect, it } from 'vitest';
import { groupKeyId } from '../diff/slices.ts';
import { parseGroupText } from './group-text.ts';

describe('a group written as text', () => {
	it('reads back what groupKeyId writes, and nothing else', () => {
		for (const text of ['ignored', 'uncategorised', 'section:auth', 'tests:auth.v2']) {
			const parsed = parseGroupText(text);
			expect(parsed.ok ? groupKeyId(parsed.value) : undefined).toBe(text);
		}
		for (const text of ['', 'section:', 'section:Not An Id', 'other:auth', 'auth']) {
			expect(parseGroupText(text).ok).toBe(false);
		}
	});
});
