import { describe, expect, it } from 'vitest';
import { parseAbsolutePath } from './absolute-path.tiny.ts';
import { parseRepositoryName, repositoryNameOf } from './repository-name.tiny.ts';

describe('repository names', () => {
	it('accept a path or a URL, even one with a newline, and refuse nothing or a NUL', () => {
		for (const name of ['/home/x/repo/.git', 'https://example.invalid/r.git', '/odd\nname']) {
			expect(parseRepositoryName(name)).toEqual({ ok: true, value: name });
		}
		expect(parseRepositoryName('').ok).toBe(false);
		expect(parseRepositoryName('a\0b').ok).toBe(false);
	});

	it('name a local repository by its path', () => {
		const path = parseAbsolutePath('/srv/repo/.git');
		if (!path.ok) throw new Error('bad test path');
		expect(repositoryNameOf(path.value)).toBe('/srv/repo/.git');
	});
});
