import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * The text of one line of a file, without its line ending. A carriage return from
 * a CRLF file is kept, because it is part of the content that changed.
 */
export type LineText = Tiny<string, 'LineText'>;

export interface InvalidLineText {
	readonly kind: 'InvalidLineText';
	readonly value: string;
}

export function parseLineText(value: string): Result<LineText, InvalidLineText> {
	if (value.includes('\n')) return err({ kind: 'InvalidLineText', value });
	return ok(value as LineText);
}
