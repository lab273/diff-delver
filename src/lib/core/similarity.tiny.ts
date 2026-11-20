import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/** How alike a renamed or copied file is to its source, as git's percentage, 0 to 100. */
export type Similarity = Tiny<number, 'Similarity'>;

export interface InvalidSimilarity {
	readonly kind: 'InvalidSimilarity';
	readonly value: number;
}

export function parseSimilarity(value: number): Result<Similarity, InvalidSimilarity> {
	if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
		return err({ kind: 'InvalidSimilarity', value });
	}
	return ok(value as Similarity);
}
