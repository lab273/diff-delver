/**
 * The scanner that stops personal or sensitive data reaching the public issue
 * data (scripts/private-data-scan.ts). Tested on strings only: nothing here reads
 * the project's issue database.
 *
 * Secret-shaped test values are put together at run time, so that no literal in
 * this file looks like a real secret to a scanner reading the repository.
 */
import { describe, expect, it } from 'vitest';
import { ALLOWED_EMAILS } from './issue-tracker-identity.ts';
import {
	describeFinding,
	mask,
	parsePrivateTerms,
	scanExport,
	scanText,
	type FindingKind,
	type ScanLists
} from './private-data-scan.ts';

const LISTS: ScanLists = { allowedEmails: ALLOWED_EMAILS, privateTerms: [] };

function kinds(text: string, lists: ScanLists = LISTS): readonly FindingKind[] {
	return scanText(text, lists).map((f) => f.kind);
}

const join = (...parts: readonly string[]): string => parts.join('');
const alnum = (n: number): string =>
	Array.from({ length: n }, (_, i) => 'aZ3kQ9mX'.charAt(i % 8)).join('');

describe('emails', () => {
	it('flags an address in any field, even an example one', () => {
		expect(kinds('Write to user@example.com about it')).toEqual(['Email']);
		expect(kinds('Owner: A.Person+tag@mail.example.co.uk.')).toEqual(['Email']);
	});

	it('lets the allow-listed addresses through, in any case', () => {
		expect(kinds('owner plog-agents@lab273.com')).toEqual([]);
		expect(kinds('Co-Authored-By: Claude <NoReply@Anthropic.com>')).toEqual([]);
		expect(kinds('remote git@github.com:lab273/diff-delver.git')).toEqual([]);
	});

	it('does not take package versions or scoped packages for addresses', () => {
		expect(kinds('pin react@18.3.1 and @types/node@26, and @axe-core/playwright')).toEqual([]);
	});

	it('flags a GitHub noreply address, which carries a username', () => {
		expect(kinds('123+someone@users.noreply.github.com')).toEqual(['Email']);
	});
});

describe('secrets', () => {
	it('flags a private key block', () => {
		expect(kinds('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl')).toEqual(['PrivateKey']);
		expect(kinds('-----BEGIN PRIVATE KEY-----')).toEqual(['PrivateKey']);
		expect(kinds('-----BEGIN PGP PRIVATE KEY BLOCK-----')).toEqual(['PrivateKey']);
		expect(kinds('-----BEGIN PUBLIC KEY-----')).toEqual([]);
	});

	it('flags GitHub tokens of every kind', () => {
		for (const prefix of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
			expect(kinds(`token ${join(prefix, '_', alnum(36))} here`)).toEqual(['GitHubToken']);
		}
		expect(kinds(join('github', '_pat_', alnum(22), '_', alnum(59)))).toEqual(['GitHubToken']);
	});

	it.each([
		['AWS', join('AKIA', 'IOSFODNN7EXAMPLE')],
		['Anthropic', join('sk-', 'ant-', 'api03-', alnum(40))],
		['OpenAI', join('sk-', 'proj-', alnum(40))],
		['Google', join('AIza', alnum(35))],
		['Stripe', join('sk', '_live_', alnum(24))],
		['Slack', join('xox', 'b-', '1234567890-', alnum(20))],
		['npm', join('npm', '_', alnum(36))],
		['GitLab', join('glpat', '-', alnum(20))],
		['JWT', join('eyJ', alnum(20), '.eyJ', alnum(20), '.', alnum(30))]
	])('flags a %s key', (_name, key) => {
		expect(kinds(`the key is ${key}.`)).toEqual(['ApiKey']);
	});

	it('flags a password or secret being set', () => {
		expect(kinds('connect with password=hunter2!')).toEqual(['PasswordAssignment']);
		expect(kinds('PASSWORD: "correct-horse"')).toEqual(['PasswordAssignment']);
		expect(kinds("api_key = 'abcd1234'")).toEqual(['PasswordAssignment']);
		expect(kinds('"client_secret": "s3cr3tvalue"')).toEqual(['PasswordAssignment']);
	});

	it('does not flag talk about passwords, or a reference to one', () => {
		expect(kinds('The password is never stored; ask for a new secret.')).toEqual([]);
		expect(kinds('password=$DB_PASSWORD and token: ${{ secrets.TOKEN }}')).toEqual([]);
		expect(kinds('api_key: <your key>, password: ****, secret: none')).toEqual([]);
		expect(kinds('secret: string')).toEqual([]);
	});

	it('flags a bearer token, but not the words', () => {
		expect(kinds(`Authorization: Bearer ${alnum(32)}`)).toEqual(['BearerToken']);
		expect(kinds('send it as a bearer token in the header')).toEqual([]);
		expect(kinds('Authorization: Bearer $TOKEN')).toEqual([]);
	});

	it('does not take commit, tree or Dolt hashes or UUIDs for secrets', () => {
		const text = [
			'Fixed in ca38afac and 4c1d2447a3f9e0b1c2d3e4f5a6b7c8d9e0f1a2b3.',
			'tree 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
			'dolt t7n76skl44mcqp1ki3ivectb547fd8mp',
			'id 123e4567-e89b-12d3-a456-426614174000'
		].join('\n');
		expect(kinds(text)).toEqual([]);
	});

	it('never shows a secret in full', () => {
		const token = join('ghp', '_', alnum(36));
		const [finding] = scanText(`use ${token}`, LISTS);
		expect(finding?.shown).toBe('ghp_… (40 characters)');
		expect(finding?.shown).not.toContain(token.slice(4));
		expect(scanText('password=hunter2!', LISTS)[0]?.shown).toBe('… (8 characters)');
	});

	it('does not show a secret that looks like an email address as one', () => {
		for (const text of ['password=hunter2@example.com', 'api_key: "abc@example.com"']) {
			const found = scanText(text, LISTS);
			expect(found.map((f) => f.kind)).toEqual(['PasswordAssignment']);
			expect(found.map((f) => f.shown).join(' ')).not.toContain('@example.com');
		}
	});

	it('still shows an email address beside a secret', () => {
		expect(kinds('password=hunter2 from someone@example.com')).toEqual([
			'Email',
			'PasswordAssignment'
		]);
	});
});

describe('secrets the first version missed', () => {
	it.each([
		['an exported token', `export GH_TOKEN=${join('ghx', alnum(37))}`],
		['a prefixed key name', `MY_API_KEY=${alnum(20)}`],
		['an AWS secret key', `AWS_SECRET_ACCESS_KEY=${alnum(40)}`],
		['a token set with a colon', `token: ${alnum(32)}`],
		['a dashed name', `x-api-key: ${alnum(24)}`]
	])('flags %s', (_name, text) => {
		expect(kinds(text)).toEqual(['PasswordAssignment']);
	});

	it('flags basic credentials in an Authorization header, but not the word', () => {
		expect(kinds(`Authorization: Basic ${alnum(24)}==`)).toEqual(['BasicCredentials']);
		expect(kinds('Basic usage: run it. Authorization: Basic $CREDENTIALS')).toEqual([]);
	});

	it('does not take talk about tokens, or short words after one, for a secret', () => {
		expect(kinds('token: see the docs, the token: expires, csrf_token: none')).toEqual([]);
		expect(kinds('token: string, tokens: 12345')).toEqual([]);
	});

	it.each([
		['https://user:hunter22@10.0.0.5/repo.git', 'hunter22'],
		['postgres://admin:S3cretPass@db.internal/app', 'S3cretPass'],
		['redis://:pw0rd123@cache.example.com:6379', 'pw0rd123']
	])('flags credentials in %s, always masked, and not as an email address', (text, password) => {
		const found = scanText(text, LISTS);
		expect(found.map((f) => f.kind)).toEqual(['UrlCredentials']);
		expect(found[0]?.shown).not.toContain(password);
	});

	it('does not take a URL with only a user name for credentials', () => {
		expect(kinds('ssh://git@github.com/lab273/diff-delver.git')).toEqual([]);
	});
});

describe('home directories', () => {
	it.each([
		['/home/someone/src/project', '/home/someone'],
		['/Users/Some.One/Library', '/Users/Some.One'],
		['C:\\Users\\someone\\AppData', 'C:\\Users\\someone'],
		['c:/users/someone/AppData', 'c:/users/someone'],
		['(at /home/someone)', '/home/someone'],
		['/var/home/someone/src', '/var/home/someone'],
		['/mnt/c/Users/someone/Documents', '/mnt/c/Users/someone']
	])('flags %s', (text, shown) => {
		expect(scanText(text, LISTS)).toEqual([{ kind: 'HomeDirectory', shown }]);
	});

	it('does not flag homes that belong to no person, or placeholders', () => {
		expect(kinds('/home/runner/work/diff-delver and /Users/Shared/x')).toEqual([]);
		expect(kinds('/home/<name> and /home/$USER and ~/src and /homes/x')).toEqual([]);
		expect(kinds('src/home/page.svelte and docs/Users/guide.md')).toEqual([]);
	});

	it('takes /Users/<name> for a macOS home only as written there: capitalised, at the start of a path, a name that starts with a letter', () => {
		expect(kinds('GET /users/123 and POST /users/someone')).toEqual([]);
		expect(kinds('GET /Users/123 and https://api.example.com/Users/someone')).toEqual([]);
		expect(kinds('nav-home-link and --home-dir and my-users-list')).toEqual([]);
	});

	it('does not flag a name with -home- or -Users- in it', () => {
		expect(kinds('the app-home-screen, a -home-screen and -Users-list')).toEqual([]);
	});
});

describe('private terms', () => {
	it('reads one term per line, skipping blank lines and comments', () => {
		expect(parsePrivateTerms('# people\nAda Lovelace\r\n\n  acme corp  \n#x\n')).toEqual([
			'Ada Lovelace',
			'acme corp'
		]);
		expect(parsePrivateTerms('')).toEqual([]);
	});

	it('finds a term in any case, as a whole word', () => {
		const lists = { ...LISTS, privateTerms: ['Ada', 'acme corp', 'Zoë'] };
		expect(scanText('ask ADA, then ada.', lists)).toEqual([
			{ kind: 'PrivateTerm', shown: 'ADA' },
			{ kind: 'PrivateTerm', shown: 'ada' }
		]);
		expect(kinds('for Acme Corp', lists)).toEqual(['PrivateTerm']);
		expect(kinds('ZOË wrote it', lists)).toEqual(['PrivateTerm']);
		expect(kinds('canadas, adapt, acme corporation, Zoëy', lists)).toEqual([]);
	});

	it('takes _, - and . as the edge of a word, as names in code and paths are written', () => {
		const lists = { ...LISTS, privateTerms: ['someone'] };
		expect(kinds('someone_dev', lists)).toEqual(['PrivateTerm']);
		expect(kinds('dev-someone.example', lists)).toEqual(['PrivateTerm']);
		expect(kinds('MY_SOMEONE_VAR', lists)).toEqual(['PrivateTerm']);
		expect(kinds('someones', lists)).toEqual([]);
	});

	it('treats a term as text, not as a pattern', () => {
		const lists = { ...LISTS, privateTerms: ['a.b (c)'] };
		expect(kinds('see a.b (c) here', lists)).toEqual(['PrivateTerm']);
		expect(kinds('see axb (c) here', lists)).toEqual([]);
	});
});

describe('scanExport', () => {
	const record = (fields: Record<string, unknown>): string => JSON.stringify(fields);

	it('finds nothing in clean records', () => {
		const jsonl = [
			record({
				id: 'dd-1',
				title: 'Fix the parser',
				owner: 'plog-agents@lab273.com',
				created_by: 'plog-agents',
				close_reason: 'Fixed in ca38afac.'
			}),
			''
		].join('\n');
		expect(scanExport(jsonl, LISTS)).toEqual([]);
	});

	it('scans every field, nested ones included, and names the issue and field', () => {
		const jsonl = [
			record({ id: 'dd-1', owner: 'someone@example.org', created_by: 'Some One' }),
			record({
				id: 'dd-2',
				notes: 'see /home/someone/x',
				comments: [{ author: 'plog-agents', text: 'ok' }, { text: 'mail me@example.net' }],
				dependencies: [{ created_by: 'Some One' }],
				labels: ['needs-human']
			})
		].join('\n');
		const lists = { ...LISTS, privateTerms: ['Some One'] };
		expect(scanExport(jsonl, lists).map(describeFinding)).toEqual([
			'dd-1 owner: an email address that is not on the allow-list: someone@example.org',
			'dd-1 created_by: a term from the private-terms file: Some One',
			'dd-2 notes: a home directory path, which names a user: /home/someone',
			'dd-2 comments[1].text: an email address that is not on the allow-list: me@example.net',
			'dd-2 dependencies[0].created_by: a term from the private-terms file: Some One'
		]);
	});

	it('reports the same thing in the same field once', () => {
		const jsonl = record({ id: 'dd-1', notes: 'a@example.com and again a@example.com' });
		expect(scanExport(jsonl, LISTS)).toHaveLength(1);
	});

	it('counts a record it cannot read as a finding, by its line', () => {
		const jsonl = [record({ id: 'dd-1' }), '{not json', '[1]', record({ title: 'x@example.com' })];
		expect(scanExport(jsonl.join('\n'), LISTS).map(describeFinding)).toEqual([
			'line 2 (whole record): a record that is not valid JSON, so it could not be checked',
			'line 3 (whole record): a record that is not valid JSON, so it could not be checked',
			'line 4 title: an email address that is not on the allow-list: x@example.com'
		]);
	});
});

describe('mask', () => {
	it('shows only the start of a long secret, and nothing of a short one', () => {
		expect(mask('abcdefghijklmnop')).toBe('abcd… (16 characters)');
		expect(mask('short')).toBe('… (5 characters)');
	});
});
