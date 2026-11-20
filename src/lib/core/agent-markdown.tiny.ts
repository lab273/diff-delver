import { err, ok, type Result } from './result.ts';
import type { Tiny } from './tiny.ts';

/**
 * Markdown written by the agent, such as the reason it gives for ignoring lines.
 * Unsanitised: it reaches a page only through the sanitiser.
 */
export type AgentMarkdown = Tiny<string, 'AgentMarkdown'>;

export interface InvalidAgentMarkdown {
	readonly kind: 'InvalidAgentMarkdown';
	readonly value: string;
	readonly reason: 'blank' | 'too-long' | 'malformed';
}

/** Generous, but bounded: agent text is stored and shown, so it cannot be unlimited. */
export const MAX_AGENT_MARKDOWN_LENGTH = 100_000;

/**
 * Accepts any text that is not blank, not longer than the limit, and well-formed
 * Unicode: a lone surrogate could not be stored or shown faithfully.
 */
export function parseAgentMarkdown(value: string): Result<AgentMarkdown, InvalidAgentMarkdown> {
	if (value.trim() === '') return err({ kind: 'InvalidAgentMarkdown', value, reason: 'blank' });
	if (value.length > MAX_AGENT_MARKDOWN_LENGTH) {
		return err({ kind: 'InvalidAgentMarkdown', value, reason: 'too-long' });
	}
	if (!value.isWellFormed())
		return err({ kind: 'InvalidAgentMarkdown', value, reason: 'malformed' });
	return ok(value as AgentMarkdown);
}
