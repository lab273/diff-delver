import type { CodeVersion } from './code-version.tiny.ts';
import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * The version of a release of diff delver: three whole numbers, as in `0.2.0`,
 * with no leading zeros and no suffix. The release workflow is given one, its
 * tag is `v` and the version (`releaseTag`), and the command a release builds
 * reports it before the code's hash, as `0.2.0+1a2b3c4d5e6f` (`CodeVersion`).
 * A build made from a clone reports the package version marked `-dev` instead,
 * which is no release.
 */
export type ReleaseVersion = Tiny<string, 'ReleaseVersion'>;

/** A release's git tag: `v0.2.0`. */
export type ReleaseTag = Tiny<string, 'ReleaseTag'>;

export interface InvalidReleaseVersion {
	readonly kind: 'InvalidReleaseVersion';
	readonly text: string;
}

const NUMBER = '(0|[1-9]\\d{0,5})';
const RELEASE = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);

/** `0.2.0`. Not `v0.2.0`, `0.2`, `00.2.0`, `0.2.0-beta`, or `0.0.0`, which comes before any release. */
export function parseReleaseVersion(text: string): Result<ReleaseVersion, InvalidReleaseVersion> {
	if (!RELEASE.test(text) || text === '0.0.0') return err({ kind: 'InvalidReleaseVersion', text });
	return ok(text as ReleaseVersion);
}

/** The release a tag names, `v0.2.0` giving `0.2.0`; undefined for any other tag. */
export function releaseOfTag(tag: string): ReleaseVersion | undefined {
	if (!tag.startsWith('v')) return undefined;
	const parsed = parseReleaseVersion(tag.slice(1));
	return parsed.ok ? parsed.value : undefined;
}

export function releaseTag(version: ReleaseVersion): ReleaseTag {
	return `v${version}` as ReleaseTag;
}

/** Negative when `a` comes before `b`, positive when after, zero when they are the same. */
export function compareReleases(a: ReleaseVersion, b: ReleaseVersion): number {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let i = 0; i < 3; i += 1) {
		const difference = (left[i] ?? 0) - (right[i] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** The release a build reports, `0.2.0` from `0.2.0+1a2b3c4d5e6f`; undefined for a build that is no release. */
export function releaseOfCodeVersion(version: CodeVersion): ReleaseVersion | undefined {
	const plus = version.indexOf('+');
	const parsed = parseReleaseVersion(plus === -1 ? version : version.slice(0, plus));
	return parsed.ok ? parsed.value : undefined;
}
