import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * Names one data folder's review cookie (`daemon/request-gate.ts`): 16
 * lowercase hex digits, made at random with the token the cookie holds and
 * kept beside it in the data folder. It is not a secret: it only keeps two
 * data folders' cookies apart in a browser that has been let into both, since
 * a browser sends a host's cookies to every port.
 */
export type BrowserAccessId = Tiny<string, 'BrowserAccessId'>;

export interface InvalidBrowserAccessId {
	readonly kind: 'InvalidBrowserAccessId';
}

export function parseBrowserAccessId(
	value: string
): Result<BrowserAccessId, InvalidBrowserAccessId> {
	if (!/^[0-9a-f]{16}$/.test(value)) return err({ kind: 'InvalidBrowserAccessId' });
	return ok(value as BrowserAccessId);
}
