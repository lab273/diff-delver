import { describe, expect, it } from 'vitest';
import { describeBuild, type BuildIdentity } from './build-identity.ts';
import { parseCommitId, type CommitId } from './commit-id.tiny.ts';
import { parseReleaseVersion, type ReleaseVersion } from './release-version.tiny.ts';
import { parseTimestamp, type Timestamp } from './timestamp.tiny.ts';

function time(hours: number): Timestamp {
	const parsed = parseTimestamp(Date.UTC(2026, 0, 15, 9, 30) + hours * 3_600_000);
	if (!parsed.ok) throw new Error('not a time');
	return parsed.value;
}

const id = 'a3f9c21' + '0'.repeat(33);
const commit = ((): CommitId => {
	const parsed = parseCommitId(id);
	if (!parsed.ok) throw new Error('not a commit');
	return parsed.value;
})();
const release = ((): ReleaseVersion => {
	const parsed = parseReleaseVersion('0.2.0');
	if (!parsed.ok) throw new Error('not a release');
	return parsed.value;
})();

const now = time(0);

describe('the build in the header', () => {
	it('gives a clone’s commit and how long ago it was made, and all of it exactly', () => {
		const build: BuildIdentity = {
			release: undefined,
			commit: { commit, committedAt: time(-2), changes: false }
		};
		expect(describeBuild(build, now)).toEqual({
			text: 'a3f9c21 · 2 hours ago',
			named: 'a3f9c21',
			ago: '2 hours ago',
			full: `Built from commit ${id}, made 15 January 2026, 07:30 UTC`
		});
	});

	it('says when the build had changes not committed', () => {
		const build: BuildIdentity = {
			release: undefined,
			commit: { commit, committedAt: time(-2), changes: true }
		};
		expect(describeBuild(build, now)).toEqual({
			text: 'a3f9c21 + changes · 2 hours ago',
			named: 'a3f9c21 + changes',
			ago: '2 hours ago',
			full: `Built from commit ${id}, made 15 January 2026, 07:30 UTC, with changes not committed`
		});
	});

	it('gives a release first, and only what is known', () => {
		expect(
			describeBuild({ release, commit: { commit, committedAt: time(-72), changes: false } }, now)
				?.text
		).toBe('v0.2.0 · a3f9c21 · 3 days ago');
		expect(describeBuild({ release, commit: undefined }, now)).toEqual({
			text: 'v0.2.0',
			named: 'v0.2.0',
			ago: undefined,
			full: 'diff delver v0.2.0'
		});
		expect(
			describeBuild(
				{ release: undefined, commit: { commit, committedAt: undefined, changes: false } },
				now
			)?.text
		).toBe('a3f9c21');
		expect(describeBuild({ release: undefined, commit: undefined }, now)).toBeUndefined();
	});
});
