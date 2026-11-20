import { describe, expect, it } from 'vitest';
import { parseAbsolutePath } from './absolute-path.tiny.ts';

describe('parseAbsolutePath', () => {
	it.each(['/', '/home/me/repo', 'C:\\Users\\me', 'd:/work', '\\\\server\\share'])(
		'accepts %s',
		(value) => {
			expect(parseAbsolutePath(value)).toEqual({ ok: true, value });
		}
	);

	it.each(['', 'relative/path', './here', 'C:relative', '/a\0b'])('rejects %j', (value) => {
		expect(parseAbsolutePath(value)).toEqual({
			ok: false,
			error: { kind: 'InvalidAbsolutePath', value }
		});
	});
});
