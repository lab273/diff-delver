import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseAbsolutePath, type AbsolutePath } from '../absolute-path.tiny.ts';
import { parseCodeVersion, type CodeVersion } from '../code-version.tiny.ts';
import { parseReportId } from '../report-id.tiny.ts';
import { reviewerMessage } from '../reviewer-message.tiny.ts';
import {
	claudeCodeCommand,
	codexConfigEntry,
	copyOf,
	dataDirectoryToName,
	plainServerCommand,
	serverWords,
	type AgentServerSetup
} from './agent-server.ts';
import { folderInWords, shellCommand, shellPath, shellWord } from './shell-words.ts';
import { goToFolderCommand, sortRequest } from './sort-request.ts';

function path(text: string): AbsolutePath {
	const parsed = parseAbsolutePath(text);
	if (!parsed.ok) throw new Error(`not a path: ${text}`);
	return parsed.value;
}

function version(text: string): CodeVersion {
	const parsed = parseCodeVersion(text);
	if (!parsed.ok) throw new Error(`not a version: ${text}`);
	return parsed.value;
}

/**
 * Reads a command line as a POSIX shell splits it into words, for what
 * `shellWord` writes: plain characters, and single-quoted runs. Anything else
 * a shell would read specially fails the test.
 */
function wordsOf(line: string): string[] {
	const words: string[] = [];
	let word: string | undefined;
	let i = 0;
	while (i < line.length) {
		const c = line.charAt(i);
		if (c === ' ') {
			if (word !== undefined) words.push(word);
			word = undefined;
			i += 1;
		} else if (c === "'") {
			const end = line.indexOf("'", i + 1);
			if (end < 0) throw new Error(`unclosed quote in ${line}`);
			word = (word ?? '') + line.slice(i + 1, end);
			i = end + 1;
		} else if (c === '\\' && line.charAt(i + 1) === "'") {
			word = (word ?? '') + "'";
			i += 2;
		} else if (/[A-Za-z0-9_@%+=:,./~-]/.test(c)) {
			word = (word ?? '') + c;
			i += 1;
		} else {
			throw new Error(`a shell would read ${JSON.stringify(c)} specially in ${line}`);
		}
	}
	if (word !== undefined) words.push(word);
	return words;
}

const RELEASE = 'https://github.com/lab273/diff-delver/releases/latest/download/diff-delver.tgz';

describe('a word for a terminal', () => {
	it('is written as it is when no shell reads any of it specially', () => {
		expect(shellWord('/srv/work/shop-2/a_b.c')).toBe('/srv/work/shop-2/a_b.c');
		expect(shellWord(RELEASE)).toBe(RELEASE);
	});

	it('is quoted when it has a space, a quote or anything a shell acts on', () => {
		expect(shellWord('/srv/my shop')).toBe("'/srv/my shop'");
		expect(shellWord("/srv/it's")).toBe("'/srv/it'\\''s'");
		expect(shellWord('/srv/$HOME;rm -rf `x`')).toBe("'/srv/$HOME;rm -rf `x`'");
		expect(shellWord('/srv/a\\b"c')).toBe("'/srv/a\\b\"c'");
		expect(shellWord('/srv/two\nlines')).toBe("'/srv/two\nlines'");
		expect(shellWord('/srv/~x*?[a]')).toBe("'/srv/~x*?[a]'");
		expect(shellWord('')).toBe("''");
	});

	it('reads back as the same word, whatever it holds', () => {
		fc.assert(
			fc.property(fc.array(fc.string({ unit: 'binary' }), { minLength: 1 }), (words) => {
				const safe = words.map((word) => word.replaceAll('\0', ''));
				expect(wordsOf(safe.map(shellWord).join(' '))).toEqual(safe);
			})
		);
	});
});

describe('a path under the home folder', () => {
	const home = path('/home/reviewer');

	it('is written from ~, with only what follows quoted, so the shell still expands it', () => {
		expect(shellPath('/home/reviewer/src/shop', home)).toBe('~/src/shop');
		expect(shellPath('/home/reviewer/my shop/it’s', home)).toBe("~/'my shop/it’s'");
		expect(shellPath('/home/reviewer', home)).toBe('~');
	});

	it('is written whole when it is not under it, or there is no home to speak of', () => {
		expect(shellPath('/home/reviewer-two/shop', home)).toBe('/home/reviewer-two/shop');
		expect(shellPath('/srv/shop', home)).toBe('/srv/shop');
		expect(shellPath('/home/reviewer/shop', undefined)).toBe('/home/reviewer/shop');
		expect(shellPath('/srv/shop', path('/'))).toBe('/srv/shop');
		expect(shellPath('C:\\Users\\r\\shop', path('C:\\Users\\r'))).toBe("'C:\\Users\\r\\shop'");
	});

	it('is named in a sentence without quotes', () => {
		expect(folderInWords(path('/home/reviewer/my shop'), home)).toBe('~/my shop');
		expect(folderInWords(path('/home/reviewer'), home)).toBe('~');
		expect(folderInWords(path('/srv/my shop'), home)).toBe('/srv/my shop');
	});

	it('joins a command’s words with each path shortened', () => {
		expect(shellCommand(['cd', '/home/reviewer/a b'], home)).toBe("cd ~/'a b'");
	});
});

describe('which copy is running', () => {
	const entry = path('/srv/clone/bin/diff-delver.js');
	const node = path('/opt/node-26/bin/node');

	it('is a release when its version is one, wherever it was run from', () => {
		expect(copyOf(version('0.2.0+1a2b3c4d5e6f'), entry, node)).toEqual({ kind: 'release' });
	});

	it('is a build run by its own file when its version is marked -dev', () => {
		expect(copyOf(version('0.2.0-dev+1a2b3c4d5e6f'), entry, node)).toEqual({
			kind: 'build',
			entry,
			node
		});
	});

	it('is given the release’s command when it cannot say which file runs it', () => {
		expect(copyOf(version('0.2.0-dev+1a2b3c4d5e6f'), undefined, node)).toEqual({ kind: 'release' });
	});
});

describe('the data folder a command names', () => {
	it('is none when it is this machine’s default, and the folder itself when it is not', () => {
		const usual = path('/home/reviewer/.local/share/diff-delver');
		expect(dataDirectoryToName(usual, usual)).toBeUndefined();
		expect(dataDirectoryToName(path('/srv/data'), usual)).toBe('/srv/data');
		expect(dataDirectoryToName(path('/srv/data'), undefined)).toBe('/srv/data');
	});
});

describe('the command that gives an agent this diff delver', () => {
	const release: AgentServerSetup = {
		copy: { kind: 'release' },
		dataDirectory: undefined,
		home: path('/home/reviewer')
	};

	it('for a release is the README’s', () => {
		expect(claudeCodeCommand(release)).toBe(
			`claude mcp add --scope user diff-delver -- npx --yes ${RELEASE} mcp`
		);
		expect(plainServerCommand(release)).toBe(`npx --yes ${RELEASE} mcp`);
		expect(codexConfigEntry(release)).toBe(
			[
				'[mcp_servers.diff-delver]',
				'command = "npx"',
				`args = ["--yes", "${RELEASE}", "mcp"]`
			].join('\n')
		);
	});

	it('for a build from a clone runs that build with the daemon’s own Node', () => {
		const build: AgentServerSetup = {
			...release,
			copy: {
				kind: 'build',
				entry: path('/home/reviewer/src/diff-delver/bin/diff-delver.js'),
				node: path('/home/reviewer/.nvm/versions/node/v26.1.0/bin/node')
			}
		};
		expect(claudeCodeCommand(build)).toBe(
			'claude mcp add --scope user diff-delver -- ~/.nvm/versions/node/v26.1.0/bin/node ~/src/diff-delver/bin/diff-delver.js mcp'
		);
		// A settings file is not read by a shell, so nothing there is written from ~.
		expect(plainServerCommand(build)).toBe(
			'/home/reviewer/.nvm/versions/node/v26.1.0/bin/node /home/reviewer/src/diff-delver/bin/diff-delver.js mcp'
		);
		expect(codexConfigEntry(build)).toBe(
			[
				'[mcp_servers.diff-delver]',
				'command = "/home/reviewer/.nvm/versions/node/v26.1.0/bin/node"',
				'args = ["/home/reviewer/src/diff-delver/bin/diff-delver.js", "mcp"]'
			].join('\n')
		);
	});

	it('for a build whose Node is not known runs it with whichever node is found first', () => {
		const build: AgentServerSetup = {
			...release,
			copy: { kind: 'build', entry: path('/srv/diff-delver/bin/diff-delver.js'), node: undefined }
		};
		expect(plainServerCommand(build)).toBe('node /srv/diff-delver/bin/diff-delver.js mcp');
	});

	it('names a data folder that is not the default, after mcp', () => {
		const elsewhere: AgentServerSetup = { ...release, dataDirectory: path('/srv/delver data') };
		expect(serverWords(elsewhere)).toEqual([
			'npx',
			'--yes',
			RELEASE,
			'mcp',
			'--data-directory',
			'/srv/delver data'
		]);
		expect(claudeCodeCommand(elsewhere)).toBe(
			`claude mcp add --scope user diff-delver -- npx --yes ${RELEASE} mcp --data-directory '/srv/delver data'`
		);
	});

	it('pastes odd folders as themselves: spaces, quotes, and what a shell would run', () => {
		const odd: AgentServerSetup = {
			copy: {
				kind: 'build',
				entry: path('/srv/it\'s "mine"/$(reboot)/bin/diff-delver.js'),
				node: path('/opt/my node/bin/node')
			},
			dataDirectory: path('/home/reviewer/data; rm -rf ~'),
			home: path('/home/reviewer')
		};
		const expected = [
			'/opt/my node/bin/node',
			'/srv/it\'s "mine"/$(reboot)/bin/diff-delver.js',
			'mcp',
			'--data-directory',
			'/home/reviewer/data; rm -rf ~'
		];
		expect(serverWords(odd)).toEqual(expected);
		expect(wordsOf(plainServerCommand(odd))).toEqual(expected);
		expect(wordsOf(claudeCodeCommand(odd))).toEqual([
			'claude',
			'mcp',
			'add',
			'--scope',
			'user',
			'diff-delver',
			'--',
			...expected.slice(0, 4),
			// From ~, which the shell expands, with the rest quoted.
			'~/data; rm -rf ~'
		]);
		expect(claudeCodeCommand(odd)).toContain("--data-directory ~/'data; rm -rf ~'");
		expect(codexConfigEntry(odd)).toContain(
			'args = ["/srv/it\'s \\"mine\\"/$(reboot)/bin/diff-delver.js", "mcp", "--data-directory", "/home/reviewer/data; rm -rf ~"]'
		);
	});
});

describe('what the person pastes to their agent', () => {
	const id = parseReportId('r_7f3a9c');
	if (!id.ok) throw new Error('not a report id');

	it('names the report by its id, says what it is, and says where to begin', () => {
		expect(
			sortRequest({
				id: id.value,
				title: reviewerMessage('Uncommitted changes'),
				repository: reviewerMessage('shop')
			})
		).toBe(
			'Sort diff delver report r_7f3a9c into sections for review: “Uncommitted changes” in shop. The report already exists, so do not create another one. Start with get_manifest for report r_7f3a9c.'
		);
	});

	it('writes out what cannot be seen in a title, so nothing unseen is pasted', () => {
		const request = sortRequest({
			id: id.value,
			title: reviewerMessage('fix\u202E compared with main'),
			repository: reviewerMessage('shop')
		});
		expect(request).not.toContain('\u202E');
		expect(request).toContain('compared with main');
	});

	it('takes a terminal to the repository, whatever its folder is called', () => {
		const home = path('/home/reviewer');
		expect(goToFolderCommand(path('/home/reviewer/src/shop'), home)).toBe('cd ~/src/shop');
		expect(goToFolderCommand(path('/srv/my shop'), home)).toBe("cd '/srv/my shop'");
	});
});
