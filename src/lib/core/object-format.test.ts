import { describe, expect, it } from 'vitest';
import { EMPTY_TREE, parseObjectFormat } from './object-format.ts';

describe('parseObjectFormat', () => {
	it("accepts git's two formats and nothing else", () => {
		expect(parseObjectFormat('sha1')).toEqual({ ok: true, value: 'sha1' });
		expect(parseObjectFormat('sha256')).toEqual({ ok: true, value: 'sha256' });
		expect(parseObjectFormat('SHA1').ok).toBe(false);
		expect(parseObjectFormat('').ok).toBe(false);
	});

	it('names an empty tree of the right length for each format', () => {
		expect(EMPTY_TREE.sha1).toHaveLength(40);
		expect(EMPTY_TREE.sha256).toHaveLength(64);
	});
});
