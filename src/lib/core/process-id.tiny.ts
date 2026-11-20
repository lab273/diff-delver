import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** An operating-system process, by its id: a positive whole number. */
export type ProcessId = Tiny<number, 'ProcessId'>;

export interface InvalidProcessId {
	readonly kind: 'InvalidProcessId';
	readonly value: number;
}

export function parseProcessId(value: number): Result<ProcessId, InvalidProcessId> {
	if (!Number.isSafeInteger(value) || value < 1) return err({ kind: 'InvalidProcessId', value });
	return ok(value as ProcessId);
}
