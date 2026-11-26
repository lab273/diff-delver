/**
 * Why a daemon stops, as its log says it before it closes, so the log tells
 * which daemon replaced which, and why one went.
 */
import type { CodeVersion } from '../code-version.tiny.ts';

export type StopReason =
	/** `diff-delver stop`. */
	| { readonly kind: 'command' }
	/** Another copy of diff delver replaced it, which says its version. */
	| { readonly kind: 'replaced'; readonly by: CodeVersion }
	/** Asked through its API without a reason, as an older copy of the command asks. */
	| { readonly kind: 'asked' }
	| { readonly kind: 'signal'; readonly signal: string }
	/** Its lockfile is gone or another's, so nothing could find or stop it. */
	| { readonly kind: 'lockfile-gone'; readonly dataDirectory: string };

/** The log's line for it: "diff delver is stopping: diff-delver stop asked it to." */
export function describeStop(reason: StopReason): string {
	switch (reason.kind) {
		case 'command':
			return 'diff delver is stopping: diff-delver stop asked it to.';
		case 'replaced':
			return `diff delver is stopping: diff delver ${reason.by} is replacing it.`;
		case 'asked':
			return 'diff delver is stopping: a copy of diff delver asked it to.';
		case 'signal':
			return `diff delver is stopping: it was sent ${reason.signal}.`;
		case 'lockfile-gone':
			return `diff delver is stopping: its lockfile in ${reason.dataDirectory} is gone or belongs to another diff delver, so nothing else could find or stop it.`;
	}
}
