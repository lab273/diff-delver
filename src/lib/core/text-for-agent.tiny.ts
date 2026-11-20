import type { Tiny } from './tiny.ts';

/**
 * Text the server writes for the agent: the labelled diff, a path as the agent
 * should write it, a rejection or a warning and what to do about it.
 *
 * Not to be confused with `AgentMarkdown`, which the agent writes. Any text is
 * valid, so making one checks nothing; the type records where the text is going,
 * so a reviewer's message cannot be sent to the agent by mistake, or the reverse.
 */
export type TextForAgent = Tiny<string, 'TextForAgent'>;

/** Marks text written by the server for the agent. */
export function textForAgent(text: string): TextForAgent {
	return text as TextForAgent;
}

/** Joins pieces of agent text. */
export function joinTextForAgent(parts: readonly TextForAgent[], separator: string): TextForAgent {
	return parts.join(separator) as TextForAgent;
}
