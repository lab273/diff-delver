/**
 * What the command says when it has replaced a running daemon of another
 * version (`ensureDaemon`): which way the versions went, and, when this copy
 * is the older one, how to get the newest. Two releases are put in order; a
 * build that is no release (a clone's, marked `-dev`) is only "different".
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

export function describeReplacedDaemon(
	running: CodeVersion,
	mine: CodeVersion,
	commandPath: string
): ReviewerMessage {
	const theirs = releaseOfCodeVersion(running);
	const ours = releaseOfCodeVersion(mine);
	if (theirs !== undefined && ours !== undefined) {
		const order = compareReleases(theirs, ours);
		if (order < 0) {
			return reviewerMessage(
				`diff delver ${ours} has replaced ${theirs}, the older version that was running. Pages the old one had open need opening again.`
			);
		}
		if (order > 0) {
			return reviewerMessage(
				`diff delver ${ours} has replaced ${theirs}, a newer version that was running, so this copy is older than one you have used. Pages the newer one had open need opening again. ${howToUpgrade(commandPath)}`
			);
		}
	}
	return reviewerMessage(
		'A different version of diff delver was running; this version has replaced it. Pages the old one had open need opening again.'
	);
}
