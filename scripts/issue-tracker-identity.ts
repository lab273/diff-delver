/**
 * Who the issue tracker records as the author of every change, and the only email
 * addresses an issue may contain (docs/DEVELOPING.md, "Tracking work"). `pnpm bd` sets the
 * identity on every `bd` command, and `pnpm bd push` refuses to publish any
 * other address. To allow another address, add it here, in this one place.
 */

/** What beads writes into `created_by`. */
export const AGENT_ACTOR = 'plog-agents';

/** What beads writes into `owner`. */
export const AGENT_EMAIL = 'plog-agents@lab273.com';

/**
 * Addresses that are not personal: the agent identity, the one in commit
 * trailers, and the SSH user of a GitHub remote (`git@github.com:owner/repo`).
 */
export const ALLOWED_EMAILS: readonly string[] = [
	AGENT_EMAIL,
	'noreply@anthropic.com',
	'git@github.com'
];

/**
 * Words that must never be published, one per line, kept only on this machine:
 * the file is ignored by git, so the list itself is never committed.
 */
export const PRIVATE_TERMS_FILE = '.beads/private-terms.txt';
