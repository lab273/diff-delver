import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** The status a process exited with: a whole number from 0 to 255. */
export type ExitCode = Tiny<number, 'ExitCode'>;

export interface InvalidExitCode {
	readonly kind: 'InvalidExitCode';
	readonly value: number;
}

export function parseExitCode(value: number): Result<ExitCode, InvalidExitCode> {
	if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
		return err({ kind: 'InvalidExitCode', value });
	}
	return ok(value as ExitCode);
}
