import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * One agent note, as the database numbers it: a whole number of 1 or more,
 * never given to another note once it is removed (the table's ids only count
 * up), so a page that still shows a removed note can never reach another.
 */
export type AgentNoteId = Tiny<number, 'AgentNoteId'>;

export interface InvalidAgentNoteId {
	readonly kind: 'InvalidAgentNoteId';
	readonly value: number;
}

export function parseAgentNoteId(value: number): Result<AgentNoteId, InvalidAgentNoteId> {
	if (!Number.isSafeInteger(value) || value < 1) return err({ kind: 'InvalidAgentNoteId', value });
	return ok(value as AgentNoteId);
}
