import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * A step's place in a section's reading order (DESIGN 4.3.1), counted from 1:
 * the 2 of "step 2 of 5".
 */
export type OrderStep = Tiny<number, 'OrderStep'>;

export interface InvalidOrderStep {
	readonly kind: 'InvalidOrderStep';
	readonly value: number;
}

/** Accepts a positive whole number. */
export function parseOrderStep(value: number): Result<OrderStep, InvalidOrderStep> {
	if (!Number.isSafeInteger(value) || value < 1) return err({ kind: 'InvalidOrderStep', value });
	return ok(value as OrderStep);
}

/** A step the code has just counted. A failure is a bug. */
export function orderStepOf(value: number): OrderStep {
	const parsed = parseOrderStep(value);
	if (!parsed.ok) throw new RangeError(`Not a step's place: ${String(value)}`);
	return parsed.value;
}
