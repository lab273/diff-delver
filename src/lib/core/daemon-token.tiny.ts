import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * The daemon's secret (DESIGN 9): 64 lowercase hex digits, 256 random bits, made
 * afresh each time a daemon starts and kept in its lockfile. A request is served
 * only with it, so another program or web page on the machine cannot use the
 * daemon by guessing its port.
 */
export type DaemonToken = Tiny<string, 'DaemonToken'>;

export interface InvalidDaemonToken {
	readonly kind: 'InvalidDaemonToken';
}

export function parseDaemonToken(value: string): Result<DaemonToken, InvalidDaemonToken> {
	if (!/^[0-9a-f]{64}$/.test(value)) return err({ kind: 'InvalidDaemonToken' });
	return ok(value as DaemonToken);
}

/**
 * Whether `given` is the token, taking the same time whatever it holds, so the
 * time an answer takes says nothing about how much of a guess was right.
 */
export function isToken(token: DaemonToken, given: string): boolean {
	let difference = given.length === token.length ? 0 : 1;
	for (let i = 0; i < token.length; i += 1) {
		difference |= token.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
	}
	return difference === 0;
}
