import { describe, expect, it } from 'vitest';
import { parseCodeVersion, type CodeVersion } from '../code-version.tiny.ts';
import {
	describeDatabaseNewer,
	describeNewerDaemon,
	describeReplacedDaemon,
	describeReplacedForPage,
	describeTooOldForDaemon,
	howToUpgrade,
	npxCopyOf,
	orderOfDaemon
} from './replaced-daemon.ts';

function version(text: string): CodeVersion {
	const parsed = parseCodeVersion(text);
	if (!parsed.ok) throw new Error(text);
	return parsed.value;
}

const NPX = '/home/someone/.npm/_npx/8441cbaa0729a68d/node_modules/.bin/diff-delver';
const CLONE = '/home/someone/src/diff-delver/bin/diff-delver.js';

describe('which of the running daemon and this command is newer', () => {
	it('puts two releases in order, by their numbers', () => {
		expect(orderOfDaemon(version('0.3.0+aaaaaaaaaaaa'), version('0.2.0+bbbbbbbbbbbb'))).toBe(
			'running-newer'
		);
		expect(orderOfDaemon(version('0.10.0+aaaaaaaaaaaa'), version('0.9.0+bbbbbbbbbbbb'))).toBe(
			'running-newer'
		);
		expect(orderOfDaemon(version('0.1.0+aaaaaaaaaaaa'), version('0.2.0+bbbbbbbbbbbb'))).toBe(
			'running-older'
		);
		expect(orderOfDaemon(version('1.0.0+aaaaaaaaaaaa'), version('0.99.99+bbbbbbbbbbbb'))).toBe(
			'running-newer'
		);
	});

	it('finds the same build the same', () => {
		expect(orderOfDaemon(version('0.2.0+aaaaaaaaaaaa'), version('0.2.0+aaaaaaaaaaaa'))).toBe(
			'same'
		);
		expect(
			orderOfDaemon(version('0.0.1-dev+aaaaaaaaaaaa'), version('0.0.1-dev+aaaaaaaaaaaa'))
		).toBe('same');
	});

	it('cannot order a development build against anything, nor one release with different code', () => {
		const pairs = [
			['0.0.1-dev+aaaaaaaaaaaa', '0.2.0+bbbbbbbbbbbb'],
			['0.3.0+aaaaaaaaaaaa', '0.0.1-dev+bbbbbbbbbbbb'],
			['0.0.1-dev+aaaaaaaaaaaa', '0.0.1-dev+bbbbbbbbbbbb'],
			['0.2.0+aaaaaaaaaaaa', '0.2.0+bbbbbbbbbbbb']
		] as const;
		for (const [running, mine] of pairs) {
			expect(orderOfDaemon(version(running), version(mine)), `${running} and ${mine}`).toBe(
				'unordered'
			);
		}
	});
});

describe('using a newer daemon that is running', () => {
	it('says so in one line, with how to bring this copy up to date', () => {
		expect(
			describeNewerDaemon(version('0.3.0+aaaaaaaaaaaa'), version('0.2.0+bbbbbbbbbbbb'), NPX)
		).toBe(
			'A newer diff delver, 0.3.0, is already running, so this copy, 0.2.0, is using it. npx keeps the copy it fetched first, so to run the newest release, delete that copy, the folder /home/someone/.npm/_npx/8441cbaa0729a68d, and run the same command again.'
		);
	});

	it('says when this copy is too old to understand it', () => {
		expect(
			describeTooOldForDaemon(version('0.3.0+aaaaaaaaaaaa'), version('0.2.0+bbbbbbbbbbbb'), CLONE)
		).toBe(
			'This copy of diff delver, 0.2.0, is too old for the newer one that is running, 0.3.0: it answered in a way this copy cannot read. To run the newest release, see "Upgrading" in the README (https://github.com/lab273/diff-delver#upgrading).'
		);
	});
});

describe('using the daemon that is running because the database is newer than this copy', () => {
	it('says this copy is older than its data folder, with how to bring it up to date', () => {
		expect(
			describeDatabaseNewer(version('0.2.0+aaaaaaaaaaaa'), version('0.0.1+bbbbbbbbbbbb'), NPX)
		).toBe(
			'This copy of diff delver, 0.0.1, is older than its data folder, which a newer diff delver has used, so it is using the diff delver that is running, 0.2.0, as it is. npx keeps the copy it fetched first, so to run the newest release, delete that copy, the folder /home/someone/.npm/_npx/8441cbaa0729a68d, and run the same command again.'
		);
	});

	it('says when the one running is a development build, which no release may catch up with', () => {
		expect(
			describeDatabaseNewer(version('0.0.1-dev+aaaaaaaaaaaa'), version('0.0.1+bbbbbbbbbbbb'), NPX)
		).toBe(
			"This copy of diff delver, 0.0.1, is older than its data folder, which a newer diff delver has used, so it is using the diff delver that is running, 0.0.1-dev+aaaaaaaaaaaa, as it is. That one is a development build, which may be newer than any release: to stop seeing this, run that build's own command, or give this copy another data folder with --data-directory."
		);
	});
});

describe('replacing a daemon of another version', () => {
	it('says an older one was replaced', () => {
		expect(
			describeReplacedDaemon(version('0.1.0+aaaaaaaaaaaa'), version('0.2.0+bbbbbbbbbbbb'), false)
		).toBe(
			'diff delver 0.2.0 has replaced 0.1.0, the older version that was running. Pages the old one had open need opening again.'
		);
	});

	it('says that open pages will offer to reload when the new one listens where the old one did', () => {
		expect(
			describeReplacedDaemon(version('0.1.0+aaaaaaaaaaaa'), version('0.2.0+bbbbbbbbbbbb'), true)
		).toBe(
			'diff delver 0.2.0 has replaced 0.1.0, the older version that was running. Pages the old one had open will offer to reload.'
		);
	});

	it('says only that it was different when either is no release, or both are the same release', () => {
		const different =
			'A different version of diff delver was running; this version has replaced it. Pages the old one had open need opening again.';
		expect(
			describeReplacedDaemon(
				version('0.0.1-dev+aaaaaaaaaaaa'),
				version('0.2.0+bbbbbbbbbbbb'),
				false
			)
		).toBe(different);
		expect(
			describeReplacedDaemon(
				version('0.3.0+aaaaaaaaaaaa'),
				version('0.0.1-dev+bbbbbbbbbbbb'),
				false
			)
		).toBe(different);
		expect(
			describeReplacedDaemon(version('0.2.0+aaaaaaaaaaaa'), version('0.2.0+bbbbbbbbbbbb'), false)
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

describe('a page served by a daemon that has since been replaced', () => {
	it('offers to reload, naming the release now running', () => {
		expect(describeReplacedForPage(version('0.2.0+bbbbbbbbbbbb'), false)).toBe(
			'This page was opened by an earlier version; diff delver 0.2.0 is running now. Reload the page to use it.'
		);
	});

	it('says to save first when something typed is not saved, and of a build that is no release', () => {
		expect(describeReplacedForPage(version('0.0.1-dev+bbbbbbbbbbbb'), true)).toBe(
			'This page was opened by an earlier version; another version of diff delver is running now. Reload the page to use it. Save what you have typed first: reloading would lose it, and your browser asks before it does.'
		);
	});
});
