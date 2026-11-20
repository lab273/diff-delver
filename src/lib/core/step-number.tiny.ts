import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** A journey step's number, counted from 1 in the order the journey takes its steps. */
export type StepNumber = Tiny<number, 'StepNumber'>;

export interface InvalidStepNumber {
	readonly kind: 'InvalidStepNumber';
	readonly value: number;
}

export function parseStepNumber(value: number): Result<StepNumber, InvalidStepNumber> {
	if (!Number.isSafeInteger(value) || value < 1) return err({ kind: 'InvalidStepNumber', value });
	return ok(value as StepNumber);
}

/** One the code has just counted, which cannot be invalid, so a failure is a bug. */
export function stepNumberOf(value: number): StepNumber {
	const parsed = parseStepNumber(value);
	if (!parsed.ok) throw new RangeError(`Not a valid StepNumber: ${String(value)}`);
	return parsed.value;
}
