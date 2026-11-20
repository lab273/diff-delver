import { describe, expect, it } from 'vitest';
import { defaultDataDirectory, describeNoDataDirectory, type Platform } from './data-directory.ts';

const dir = (
	platform: Platform,
	home: string | undefined,
	variables: Record<string, string> = {}
) => defaultDataDirectory({ platform, home, variables });

describe('defaultDataDirectory', () => {
	it('follows the XDG specification on Linux', () => {
		expect(dir('linux', '/home/a')).toEqual({
			ok: true,
			value: '/home/a/.local/share/diff-delver'
		});
		expect(dir('linux', '/home/a', { XDG_DATA_HOME: '/data/' })).toEqual({
			ok: true,
			value: '/data/diff-delver'
		});
		// A relative XDG_DATA_HOME is invalid and is ignored, as the specification says.
		expect(dir('freebsd', '/home/a', { XDG_DATA_HOME: 'relative' })).toEqual({
			ok: true,
			value: '/home/a/.local/share/diff-delver'
		});
	});

	it('uses Application Support on macOS', () => {
		expect(dir('darwin', '/Users/a', { XDG_DATA_HOME: '/ignored' })).toEqual({
			ok: true,
			value: '/Users/a/Library/Application Support/diff-delver'
		});
	});

	it('uses the local application data folder on Windows', () => {
		expect(dir('win32', 'C:\\Users\\a', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })).toEqual({
			ok: true,
			value: 'C:\\Users\\a\\AppData\\Local\\diff-delver'
		});
		expect(dir('win32', 'C:\\Users\\a')).toEqual({
			ok: true,
			value: 'C:\\Users\\a\\AppData\\Local\\diff-delver'
		});
	});

	it('says what is missing when there is no home', () => {
		const result = dir('linux', undefined);
		expect(result).toEqual({ ok: false, error: { kind: 'NoDataDirectory', missing: 'HOME' } });
		if (!result.ok) expect(describeNoDataDirectory(result.error)).toContain('HOME is not set');
		expect(dir('win32', undefined).ok).toBe(false);
	});
});
