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
 *   shapes, `password=`-style assignments (`MY_API_KEY=…` and `token: …` too),
 *   bearer and basic credentials in an Authorization header, and a password in a
 *   URL (`postgres://user:password@host`);
 * - home directory paths, which carry a username: `/home/<name>`,
 *   `/var/home/<name>`, `C:\Users\<name>`, `/mnt/c/Users/<name>`, and the same with
 *   the separators turned into hyphens (`-home-<name>-src`), as some tools name
 *   directories. `/Users/<name>` counts only as macOS writes it: capitalised, at
 *   the start of a path, with a name that starts with a letter, so `GET /users/123`
 *   is not one;
 * - the private terms the person has listed, as whole words, in any case, where
 *   `_`, `-` and `.` also end a word, so `someone` is found in `someone_dev`.
 *
 * It is a helper that catches honest mistakes, not a guarantee, so it prefers
 * fewer, more certain findings to broad patterns. A finding shows enough to find
 * the text again, and no more: a secret is shown only by its first characters and
 * its length.
 */

import { fieldPath, type FieldPath } from '../src/lib/core/field-path.tiny.ts';
import { issueLocation, type IssueLocation } from '../src/lib/core/issue-location.tiny.ts';
import { shownText, type ShownText } from '../src/lib/core/shown-text.tiny.ts';

/** What kind of thing was found. */
export type FindingKind =
	| 'Email'
	| 'PrivateKey'
	| 'GitHubToken'
	| 'ApiKey'
	| 'PasswordAssignment'
	| 'BearerToken'
	| 'BasicCredentials'
	| 'UrlCredentials'
	| 'HomeDirectory'
	| 'PrivateTerm'
	| 'UnreadableRecord';

export interface Finding {
	/** The issue's id, or the line of the export when the record has none. */
	readonly issue: IssueLocation;
	/** Where in the record, such as `notes` or `comments[2].text`. */
	readonly field: FieldPath;
	readonly kind: FindingKind;
	/** What was found, safe to print: a secret is masked. */
	readonly shown: ShownText;
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

/** A secret value that is at least long and mixed enough to be a generated token. */
function looksGenerated(value: string): boolean {
	return value.length >= 16 && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

/**
 * The start of a key name: not inside a word, though a name may be prefixed, as in
 * `MY_API_KEY` or `x-api-key`.
 */
const KEY_START = String.raw`(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*`;

/** `=` or `:` after a key name, with the quotes JSON, YAML and shells put around them. */
const ASSIGNED = String.raw`["']?\s*[:=]\s*["']?`;

/** `scheme://user:password@`: the password is group 1. */
const URL_CREDENTIALS = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]*:([^\s/@]+)@/g;

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

/** Characters a username in a path may have after its first. Excludes `<`, `$`, `{` and `%`, so `/home/<name>` and `/home/$USER` are not flagged. */
const USERNAME_REST = String.raw`[^\s/\\'"\x60<>(){}\[\],;:$%]*`;

const USERNAME = String.raw`[A-Za-z0-9_]${USERNAME_REST}`;

/** A macOS user name starts with a letter, so `/Users/123` is an id in a URL, not a home. */
const MAC_USERNAME = String.raw`[A-Za-z]${USERNAME_REST}`;

/** In a hyphenated path the name ends at the next hyphen. */
const MAC_USERNAME_IN_HYPHENS = String.raw`[A-Za-z][A-Za-z0-9_.]*`;

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
		pattern: new RegExp(
			`${KEY_START}(?:password|passwd|pwd|passphrase|secret|client[_-]?secret|secret[_-]?access[_-]?key|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)${ASSIGNED}([^\\s"',;]{4,})`,
			'gi'
		),
		secret: true,
		accept: (found) => !isReference(found)
	},
	{
		// A plain `token`, as in `GH_TOKEN=` or `token:`, is a common word, so only a
		// value that looks generated counts.
		kind: 'PasswordAssignment',
		pattern: new RegExp(`${KEY_START}token${ASSIGNED}([^\\s"',;]{4,})`, 'gi'),
		secret: true,
		accept: (found) => !isReference(found) && looksGenerated(found)
	},
	{
		kind: 'BearerToken',
		pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gi,
		secret: true,
		accept: (found) => !isReference(found)
	},
	{
		kind: 'BasicCredentials',
		pattern: /\bAuthorization["']?\s*[:=]\s*["']?Basic\s+([A-Za-z0-9+/]{8,}={0,2})/gi,
		secret: true
	},
	{
		kind: 'UrlCredentials',
		pattern: URL_CREDENTIALS,
		secret: true,
		accept: (found) => !isReference(found)
	},
	{
		// Linux, Fedora Atomic's /var/home, and WSL's view of a Windows home. As
		// Linux and macOS write them: case matters.
		kind: 'HomeDirectory',
		pattern: new RegExp(
			[
				String.raw`(?<![\w.~/-])(?:/var)?/home/(${USERNAME})`,
				String.raw`(?<![\w.~/-])(?:/mnt/[a-z])?/Users/(${MAC_USERNAME})`,
				// A path with its separators turned into hyphens, as some tools name directories.
				String.raw`(?<![\w.~-])-(?:home|Users)-(${MAC_USERNAME_IN_HYPHENS})`
			].join('|'),
			'g'
		),
		secret: false,
		accept: (found) => !SHARED_HOMES.has(found.toLowerCase())
	},
	{
		kind: 'HomeDirectory',
		pattern: new RegExp(String.raw`\b[A-Za-z]:[\\/]+Users[\\/]+(${USERNAME})`, 'gi'),
		secret: false,
		accept: (found) => !SHARED_HOMES.has(found.toLowerCase())
	}
];

/** Shows the start of a secret and its length, never the whole of it. */
export function mask(secret: string): ShownText {
	const length = Array.from(secret).length;
	const start = length >= 12 ? Array.from(secret).slice(0, 4).join('') : '';
	return shownText(`${start}… (${String(length)} characters)`);
}

// --- Private terms -------------------------------------------------------------------

/** The terms in a private-terms file: one per line, blank lines and `#` comments skipped. */
export function parsePrivateTerms(text: string): readonly string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'));
}

/** Letters and digits. `_`, `-` and `.` end a word, as in `someone_dev` or `dev-someone`. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Matches a term in any case, as a whole word: a term that starts or ends with a
 * letter or digit must not run on into one, so "Al" is not found in "also".
 */
function termPattern(term: string): RegExp {
	const chars = Array.from(term);
	const before = WORD_CHAR.test(chars[0] ?? '') ? String.raw`(?<![\p{L}\p{N}])` : '';
	const after = WORD_CHAR.test(chars.at(-1) ?? '') ? String.raw`(?![\p{L}\p{N}])` : '';
	return new RegExp(`${before}${escapeRegex(term)}${after}`, 'giu');
}

// --- Scanning ------------------------------------------------------------------------

/** Every finding in one string. */
export function scanText(
	text: string,
	lists: ScanLists
): readonly Omit<Finding, 'issue' | 'field'>[] {
	const found: Omit<Finding, 'issue' | 'field'>[] = [];
	// `user:password@host` holds what looks like an address; it is reported, masked,
	// as credentials, and never shown as an email address.
	const credentials = [...text.matchAll(URL_CREDENTIALS)].map((m) => ({
		from: m.index,
		to: m.index + m[0].length
	}));
	const inCredentials = (at: number): boolean =>
		credentials.some(({ from, to }) => at >= from && at < to);
	// Two detectors can find one value, as `access_token=` and `token=` both do.
	const reported = new Set<string>();
	for (const detector of DETECTORS) {
		for (const match of text.matchAll(detector.pattern)) {
			if (detector.kind === 'Email' && inCredentials(match.index)) continue;
			const key = `${detector.kind} ${String(match.index + match[0].length)}`;
			if (reported.has(key)) continue;
			reported.add(key);
			// A group that did not take part in the match is undefined, whatever the type says.
			const groups: readonly (string | undefined)[] = match.slice(1);
			const value = groups.find((group) => group !== undefined) ?? match[0];
			if (detector.accept !== undefined && !detector.accept(value, lists)) continue;
			found.push({
				kind: detector.kind,
				shown: detector.secret ? mask(value) : shownText(match[0])
			});
		}
	}
	for (const term of lists.privateTerms) {
		for (const match of text.matchAll(termPattern(term))) {
			found.push({ kind: 'PrivateTerm', shown: shownText(match[0]) });
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
		const where = issueLocation(`line ${String(index + 1)}`);
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			record = undefined;
		}
		if (typeof record !== 'object' || record === null || Array.isArray(record)) {
			add({
				issue: where,
				field: fieldPath('(whole record)'),
				kind: 'UnreadableRecord',
				shown: shownText('')
			});
			return;
		}
		const id: unknown = Object.entries(record).find(([key]) => key === 'id')?.[1];
		const issue = typeof id === 'string' && id !== '' ? issueLocation(id) : where;
		walk(record, '', (field, text) => {
			for (const found of scanText(text, lists)) add({ issue, field: fieldPath(field), ...found });
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
		case 'BasicCredentials':
			return 'what looks like a user name and password in an Authorization header';
		case 'UrlCredentials':
			return 'a password in a URL';
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
