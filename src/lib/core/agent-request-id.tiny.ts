import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * One request of the reviewer to the agent, as the database numbers it: a whole number of 1 or more,
 * never given to another request once it is removed (the table's ids only count
 * up), so a page that still shows a removed request can never reach another.
 */
export type AgentRequestId = Tiny<number, 'AgentRequestId'>;

export interface InvalidAgentRequestId {
	readonly kind: 'InvalidAgentRequestId';
	readonly value: number;
}

export function parseAgentRequestId(value: number): Result<AgentRequestId, InvalidAgentRequestId> {
	if (!Number.isSafeInteger(value) || value < 1)
		return err({ kind: 'InvalidAgentRequestId', value });
	return ok(value as AgentRequestId);
}
