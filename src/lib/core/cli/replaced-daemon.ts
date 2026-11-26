/**
 * A running daemon of another version than the command (`ensureDaemon`):
 * which of the two is newer, and what the command says about it.
 *
 * Two releases are put in order by their numbers. A build that is no release (a
 * clone's, marked `-dev`), on either side, and one release built from different
 * code cannot be put in order: they are only "different".
 *
 * - The daemon is newer: the command uses it as it is, since the older copy
 *   could not read a database the newer one has changed, and says how to bring
 *   this copy up to date.
 * - The daemon is older, or the two cannot be put in order: the command
 *   replaces it and says so, unless the data folder's database is newer than
 *   this copy knows. Then this copy could not start a daemon of its own, so it
 *   uses the running one as it is and says how to bring this copy up to date.
 */
import type { CodeVersion } from '../code-version.tiny.ts';
import { compareReleases, releaseOfCodeVersion } from '../release-version.tiny.ts';
import { reviewerMessage, type ReviewerMessage } from '../reviewer-message.tiny.ts';

/** Where the README says how to upgrade. */
export const UPGRADING_ADDRESS = 'https://github.com/lab273/diff-delver#upgrading';

/**
 * The folder npx keeps this copy in, when npx ran it: `<cache>/_npx/<hash>`,
 * from the path of the command that is running. npx keeps that copy and runs
 * it again whatever the address now gives, so deleting it is how to upgrade.
 */
export function npxCopyOf(commandPath: string): string | undefined {
	const found = /^(.*[\\/]_npx[\\/][0-9a-f]+)[\\/]/.exec(commandPath);
	return found?.[1];
}

/** How to move from this copy to the newest release. */
export function howToUpgrade(commandPath: string): string {
	const copy = npxCopyOf(commandPath);
	if (copy !== undefined) {
		return `npx keeps the copy it fetched first, so to run the newest release, delete that copy, the folder ${copy}, and run the same command again.`;
	}
	return `To run the newest release, see "Upgrading" in the README (${UPGRADING_ADDRESS}).`;
}

/** How the running daemon's version stands to the command's own. */
export type DaemonOrder = 'same' | 'running-newer' | 'running-older' | 'unordered';

export function orderOfDaemon(running: CodeVersion, mine: CodeVersion): DaemonOrder {
	if (running === mine) return 'same';
	const theirs = releaseOfCodeVersion(running);
	const ours = releaseOfCodeVersion(mine);
	if (theirs === undefined || ours === undefined) return 'unordered';
	const order = compareReleases(theirs, ours);
	return order > 0 ? 'running-newer' : order < 0 ? 'running-older' : 'unordered';
}

/** The release a build reports, or the whole version of a build that is no release. */
function shown(version: CodeVersion): string {
	return releaseOfCodeVersion(version) ?? version;
}

/** What the command says when it uses a newer daemon that is running. */
export function describeNewerDaemon(
	running: CodeVersion,
	mine: CodeVersion,
	commandPath: string
): ReviewerMessage {
	return reviewerMessage(
		`A newer diff delver, ${shown(running)}, is already running, so this copy, ${shown(mine)}, is using it. ${howToUpgrade(commandPath)}`
	);
}

/**
 * What the command says when it uses the daemon that is running because the
 * data folder's database is newer than this copy knows.
 */
export function describeDatabaseNewer(
	running: CodeVersion,
	mine: CodeVersion,
	commandPath: string
): ReviewerMessage {
	return reviewerMessage(
		`This copy of diff delver, ${shown(mine)}, is older than its data folder, which a newer diff delver has used, so it is using the diff delver that is running, ${shown(running)}, as it is. ${howToUpgrade(commandPath)}`
	);
}

/** What the command says when a newer daemon it is using answered in a way it cannot read. */
export function describeTooOldForDaemon(
	running: CodeVersion,
	mine: CodeVersion,
	commandPath: string
): ReviewerMessage {
	return reviewerMessage(
		`This copy of diff delver, ${shown(mine)}, is too old for the newer one that is running, ${shown(running)}: it answered in a way this copy cannot read. ${howToUpgrade(commandPath)}`
	);
}

/** What the command says when it has replaced an older daemon, or one it cannot put in order. */
export function describeReplacedDaemon(running: CodeVersion, mine: CodeVersion): ReviewerMessage {
	const theirs = releaseOfCodeVersion(running);
	const ours = releaseOfCodeVersion(mine);
	if (theirs !== undefined && ours !== undefined) {
		const order = compareReleases(theirs, ours);
		if (order < 0) {
			return reviewerMessage(
				`diff delver ${ours} has replaced ${theirs}, the older version that was running. Pages the old one had open need opening again.`
			);
		}
	}
	return reviewerMessage(
		'A different version of diff delver was running; this version has replaced it. Pages the old one had open need opening again.'
	);
}
