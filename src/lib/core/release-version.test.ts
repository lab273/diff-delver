import { describe, expect, it } from 'vitest';
import { parseCodeVersion } from './code-version.tiny.ts';
import {
	compareReleases,
	parseReleaseVersion,
	releaseOfCodeVersion,
	releaseOfTag,
	releaseTag,
	type ReleaseVersion
} from './release-version.tiny.ts';

function release(text: string): ReleaseVersion {
	const parsed = parseReleaseVersion(text);
	if (!parsed.ok) throw new Error(`Not a release: ${text}`);
	return parsed.value;
}

describe('release versions', () => {
	it('are three whole numbers with no leading zeros, after 0.0.0', () => {
		for (const good of ['0.0.1', '0.2.0', '1.0.0', '12.345.6789']) {
			expect(parseReleaseVersion(good).ok).toBe(true);
		}
		for (const bad of [
			'',
			'0.0.0',
			'v0.2.0',
			'0.2',
			'0.2.0.1',
			'00.2.0',
			'0.02.0',
			'0.2.0-beta',
			' 0.2.0',
			'0.2.0+abc',
			'1234567.0.0'
		]) {
			expect(parseReleaseVersion(bad)).toEqual({
				ok: false,
				error: { kind: 'InvalidReleaseVersion', text: bad }
			});
		}
	});

	it('compare number by number, not as text', () => {
		expect(compareReleases(release('0.10.0'), release('0.9.9'))).toBeGreaterThan(0);
		expect(compareReleases(release('0.2.0'), release('1.0.0'))).toBeLessThan(0);
		expect(compareReleases(release('1.2.3'), release('1.2.3'))).toBe(0);
	});

	it('have a tag of v and the version, and only such a tag names a release', () => {
		expect(releaseTag(release('0.2.0'))).toBe('v0.2.0');
		expect(releaseOfTag('v0.2.0')).toBe('0.2.0');
		expect(releaseOfTag('0.2.0')).toBeUndefined();
		expect(releaseOfTag('v0.2.0-beta')).toBeUndefined();
		expect(releaseOfTag('nightly')).toBeUndefined();
	});

	it('are read from a released build, and not from a build of a clone or the sources', () => {
		const of = (text: string): ReleaseVersion | undefined => {
			const parsed = parseCodeVersion(text);
			if (!parsed.ok) throw new Error(text);
			return releaseOfCodeVersion(parsed.value);
		};
		expect(of('0.2.0+1a2b3c4d5e6f')).toBe('0.2.0');
		expect(of('0.0.1-dev+1a2b3c4d5e6f')).toBeUndefined();
		expect(of('0.0.1-dev+source')).toBeUndefined();
		expect(of('journey')).toBeUndefined();
	});
});
