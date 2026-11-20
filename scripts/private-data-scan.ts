/**
 * Finds personal or sensitive data in an export of the issue tracker, before it
 * is published (README, "Tracking work"). Pure: it takes the export's text and
 * the lists to check against, and returns what it found.
 *
 * It looks at every string in every record, however deeply nested: titles,
 * descriptions, notes, comments, close reasons, `owner`, `created_by`, labels and
 * dependencies alike. It flags:
 *
 * - email addresses that are not on the allow-list;
 * - what looks like a secret: private key blocks, GitHub tokens, common API key
 *   shapes, `password=`-style assignments and bearer tokens;
 * - home directory paths, which carry a username;
 * - the private terms the person has listed, as whole words, in any case.
 *
 * A finding shows enough to find the text again, and no more: a secret is shown
 * only by its first characters and its length.
 */

/** What kind of thing was found. */
export type FindingKind =
	| 'Email'
	| 'PrivateKey'
	| 'GitHubToken'
	| 'ApiKey'
	| 'PasswordAssignment'
	| 'BearerToken'
	| 'HomeDirectory'
	| 'PrivateTerm'
	| 'UnreadableRecord';

export interface Finding {
	/** The issue's id, or the line of the export when the record has none. */
	readonly issue: string;
	/** Where in the record, such as `notes` or `comments[2].text`. */
	readonly field: string;
	readonly kind: FindingKind;
	/** What was found, safe to print: a secret is masked. */
	readonly shown: string;
}

export interface ScanLists {
	/** Email addresses that may appear. Compared without regard to case. */
	readonly allowedEmails: readonly string[];
	/** Private terms, as `parsePrivateTerms` returns them. */
	readonly privateTerms: readonly string[];
}

// --- Detectors ---------------------------------------------------------------------

interface Detector {
	readonly kind: FindingKind;
	/** Global. The text to report is capture group 1 if there is one, else the match. */
	readonly pattern: RegExp;
	/** Masked when shown. */
	readonly secret: boolean;
	/** False for a match that is not what it looks like. */
	readonly accept?: (found: string, lists: ScanLists) => boolean;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Words that stand for no real value in `password: none` or `secret: string`. */
const PLACEHOLDER_VALUES = new Set([
	'none',
	'null',
	'nil',
	'true',
	'false',
	'undefined',
	'redacted',
	'required',
	'optional',
	'unset',
	'empty',
	'placeholder',
	'example',
	'string',
	'number'
]);

/** A value that refers to a secret rather than being one: `$TOKEN`, `<token>`, `${{ secrets.X }}`, `***`. */
function isReference(value: string): boolean {
	return (
		/^[$<{%]/.test(value) || /^[*x.]+$/i.test(value) || PLACEHOLDER_VALUES.has(value.toLowerCase())
	);
}

/** Characters a username in a path may have. Excludes `<`, `$`, `{` and `%`, so `/home/<name>` and `/home/$USER` are not flagged. */
const USERNAME = String.raw`[A-Za-z0-9_][^\s/\\'"\x60<>(){}\[\],;:$%]*`;

/** Home directories that belong to no person. */
const SHARED_HOMES = new Set(['runner', 'shared', 'public', 'default', 'all users']);

const DETECTORS: readonly Detector[] = [
	{
		kind: 'Email',
		pattern: EMAIL,
		secret: false,
		accept: (found, lists) =>
			!lists.allowedEmails.some((allowed) => allowed.toLowerCase() === found.toLowerCase())
	},
	{
		kind: 'PrivateKey',
		pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
		secret: false
	},
	{
		kind: 'GitHubToken',
		pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
		secret: true
	},
	{
		kind: 'ApiKey',
		pattern: new RegExp(
			[
				String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, // AWS access key id
				String.raw`\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}`, // Anthropic, OpenAI
				String.raw`\bAIza[0-9A-Za-z_-]{35}`, // Google
				String.raw`\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}`, // Stripe
				String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`, // Slack
				String.raw`\bnpm_[A-Za-z0-9]{36}\b`, // npm
				String.raw`\bglpat-[A-Za-z0-9_-]{20,}`, // GitLab
				String.raw`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` // JWT
			].join('|'),
			'g'
		),
		secret: true
	},
	{
		kind: 'PasswordAssignment',
		pattern:
			/\b(?:password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?\s*[:=]\s*["']?([^\s"',;]{4,})/gi,
		secret: true,
		accept: (found) => !isReference(found)
	},
	{
		kind: 'BearerToken',
		pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gi,
		secret: true,
		accept: (found) => !isReference(found)
	},
	{
		kind: 'HomeDirectory',
		pattern: new RegExp(
			[
				String.raw`(?<![\w.~-])/home/(${USERNAME})`,
				String.raw`(?<![\w.~-])/Users/(${USERNAME})`,
				String.raw`\b[A-Za-z]:[\\/]+Users[\\/]+(${USERNAME})`
			].join('|'),
			'gi'
		),
		secret: false,
		accept: (found) => !SHARED_HOMES.has(found.toLowerCase())
	}
];

/** Shows the start of a secret and its length, never the whole of it. */
export function mask(secret: string): string {
	const length = Array.from(secret).length;
	const start = length >= 12 ? Array.from(secret).slice(0, 4).join('') : '';
	return `${start}… (${String(length)} characters)`;
}

// --- Private terms -------------------------------------------------------------------

/** The terms in a private-terms file: one per line, blank lines and `#` comments skipped. */
export function parsePrivateTerms(text: string): readonly string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'));
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Matches a term in any case, as a whole word: a term that starts or ends with a
 * letter or digit must not run on into one, so "Al" is not found in "also".
 */
function termPattern(term: string): RegExp {
	const chars = Array.from(term);
	const before = WORD_CHAR.test(chars[0] ?? '') ? String.raw`(?<![\p{L}\p{N}_])` : '';
	const after = WORD_CHAR.test(chars.at(-1) ?? '') ? String.raw`(?![\p{L}\p{N}_])` : '';
	return new RegExp(`${before}${escapeRegex(term)}${after}`, 'giu');
}

// --- Scanning ------------------------------------------------------------------------

/** Every finding in one string. */
export function scanText(
	text: string,
	lists: ScanLists
): readonly Omit<Finding, 'issue' | 'field'>[] {
	const found: Omit<Finding, 'issue' | 'field'>[] = [];
	for (const detector of DETECTORS) {
		for (const match of text.matchAll(detector.pattern)) {
			// A group that did not take part in the match is undefined, whatever the type says.
			const groups: readonly (string | undefined)[] = match.slice(1);
			const value = groups.find((group) => group !== undefined) ?? match[0];
			if (detector.accept !== undefined && !detector.accept(value, lists)) continue;
			found.push({ kind: detector.kind, shown: detector.secret ? mask(value) : match[0] });
		}
	}
	for (const term of lists.privateTerms) {
		for (const match of text.matchAll(termPattern(term))) {
			found.push({ kind: 'PrivateTerm', shown: match[0] });
		}
	}
	return found;
}

/** Calls `visit` for every string in a JSON value, with its path. */
function walk(value: unknown, path: string, visit: (path: string, text: string) => void): void {
	if (typeof value === 'string') {
		visit(path, value);
	} else if (Array.isArray(value)) {
		const items: readonly unknown[] = value;
		items.forEach((item, i) => {
			walk(item, `${path}[${String(i)}]`, visit);
		});
	} else if (typeof value === 'object' && value !== null) {
		for (const [key, child] of Object.entries(value)) {
			walk(child, path === '' ? key : `${path}.${key}`, visit);
		}
	}
}

/**
 * Scans an export of the issue tracker (`bd export`): one JSON record per line.
 * A line that is not a JSON object is a finding too, since it could not be
 * checked.
 */
export function scanExport(jsonl: string, lists: ScanLists): readonly Finding[] {
	const findings: Finding[] = [];
	const seen = new Set<string>();
	const add = (finding: Finding): void => {
		const key = JSON.stringify([finding.issue, finding.field, finding.kind, finding.shown]);
		if (seen.has(key)) return;
		seen.add(key);
		findings.push(finding);
	};
	jsonl.split('\n').forEach((line, index) => {
		if (line.trim() === '') return;
		const where = `line ${String(index + 1)}`;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			record = undefined;
		}
		if (typeof record !== 'object' || record === null || Array.isArray(record)) {
			add({ issue: where, field: '(whole record)', kind: 'UnreadableRecord', shown: '' });
			return;
		}
		const id: unknown = Object.entries(record).find(([key]) => key === 'id')?.[1];
		const issue = typeof id === 'string' && id !== '' ? id : where;
		walk(record, '', (field, text) => {
			for (const found of scanText(text, lists)) add({ issue, field, ...found });
		});
	});
	return findings;
}

// --- Saying so ------------------------------------------------------------------------

/** Why a finding stops the push, in a few words. */
export function findingReason(kind: FindingKind): string {
	switch (kind) {
		case 'Email':
			return 'an email address that is not on the allow-list';
		case 'PrivateKey':
			return 'a private key';
		case 'GitHubToken':
			return 'what looks like a GitHub token';
		case 'ApiKey':
			return 'what looks like an API key';
		case 'PasswordAssignment':
			return 'what looks like a password or secret being set';
		case 'BearerToken':
			return 'what looks like a bearer token';
		case 'HomeDirectory':
			return 'a home directory path, which names a user';
		case 'PrivateTerm':
			return 'a term from the private-terms file';
		case 'UnreadableRecord':
			return 'a record that is not valid JSON, so it could not be checked';
		default: {
			const unknown: never = kind;
			return unknown;
		}
	}
}

/** One line per finding: the issue, the field, the reason and what was found. */
export function describeFinding(finding: Finding): string {
	const shown = finding.shown === '' ? '' : `: ${finding.shown}`;
	return `${finding.issue} ${finding.field}: ${findingReason(finding.kind)}${shown}`;
}
