import { describe, expect, it } from 'vitest';
import { parseCodeVersion, type CodeVersion } from '../code-version.tiny.ts';
import { describeReplacedDaemon, howToUpgrade, npxCopyOf } from './replaced-daemon.ts';

function version(text: string): CodeVersion {
	const parsed = parseCodeVersion(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

const NPX = '/home/someone/.npm/_npx/8441cbaa0729a68d/node_modules/.bin/diff-delver';
const CLONE = '/home/someone/src/diff-delver/bin/diff-delver.js';

describe('replacing a daemon of another version', () => {
	it('says an older one was replaced', () => {
		expect(
			describeReplacedDaemon(version('0.1.0+aaaaaaaaaaaa'), version('0.2.0+bbbbbbbbbbbb'), NPX)
		).toBe(
			'diff delver 0.2.0 has replaced 0.1.0, the older version that was running. Pages the old one had open need opening again.'
		);
	});

	it('says when this copy is the older one, and how to get the newest', () => {
		expect(
			describeReplacedDaemon(version('0.10.0+aaaaaaaaaaaa'), version('0.9.0+bbbbbbbbbbbb'), NPX)
		).toBe(
			'diff delver 0.9.0 has replaced 0.10.0, a newer version that was running, so this copy is older than one you have used. Pages the newer one had open need opening again. npx keeps the copy it fetched first, so to run the newest release, delete that copy, the folder /home/someone/.npm/_npx/8441cbaa0729a68d, and run the same command again.'
		);
	});

	it('says only that it was different when either is no release, or both are the same release', () => {
		const different =
			'A different version of diff delver was running; this version has replaced it. Pages the old one had open need opening again.';
		expect(
			describeReplacedDaemon(version('0.0.1-dev+aaaaaaaaaaaa'), version('0.2.0+bbbbbbbbbbbb'), NPX)
		).toBe(different);
		expect(
			describeReplacedDaemon(
				version('0.3.0+aaaaaaaaaaaa'),
				version('0.0.1-dev+bbbbbbbbbbbb'),
				CLONE
			)
		).toBe(different);
		expect(
			describeReplacedDaemon(version('0.2.0+aaaaaaaaaaaa'), version('0.2.0+bbbbbbbbbbbb'), NPX)
		).toBe(different);
	});
});

describe('how to upgrade', () => {
	it("names npx's copy when npx ran this one, on any system", () => {
		expect(npxCopyOf(NPX)).toBe('/home/someone/.npm/_npx/8441cbaa0729a68d');
		expect(
			npxCopyOf(
				'C:\\Users\\someone\\AppData\\Local\\npm-cache\\_npx\\8441cbaa0729a68d\\node_modules\\diff-delver\\bin\\diff-delver.js'
			)
		).toBe('C:\\Users\\someone\\AppData\\Local\\npm-cache\\_npx\\8441cbaa0729a68d');
		expect(npxCopyOf(CLONE)).toBeUndefined();
	});

	it('points elsewhere to the README', () => {
		expect(howToUpgrade(CLONE)).toBe(
			'To run the newest release, see "Upgrading" in the README (https://github.com/lab273/diff-delver#upgrading).'
		);
	});
});
