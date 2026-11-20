import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A TCP port the daemon listens on: a whole number from 1 to 65535. */
export type PortNumber = Tiny<number, 'PortNumber'>;

export interface InvalidPortNumber {
	readonly kind: 'InvalidPortNumber';
	readonly value: number;
}

export function parsePortNumber(value: number): Result<PortNumber, InvalidPortNumber> {
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		return err({ kind: 'InvalidPortNumber', value });
	}
	return ok(value as PortNumber);
}
