/**
 * A repository on GitHub, and finding it among a local repository's remotes:
 * the remote whose address points at GitHub, `origin` first (DESIGN 3.1, the
 * GitHub PR row). Only github.com so far; GitHub Enterprise would add its hosts.
 */
import type { RemoteName } from '../history/remote-name.tiny.ts';
import { GITHUB_COM, parseGitHubHost, type GitHubHost } from './github-host.tiny.ts';
import { parseGitHubOwner, type GitHubOwner } from './github-owner.tiny.ts';
import {
	parseGitHubRepositoryName,
	type GitHubRepositoryName
} from './github-repository-name.tiny.ts';

export interface GitHubRepository {
	readonly host: GitHubHost;
	readonly owner: GitHubOwner;
	readonly name: GitHubRepositoryName;
}

/** A remote of a local repository and the address it fetches from. */
export interface RemoteAddress {
	readonly remote: RemoteName;
	readonly url: string;
}

/** The hosts whose pull requests diff delver can open. */
const KNOWN_HOSTS: ReadonlySet<string> = new Set([GITHUB_COM]);

/** The repository named by an owner and a name, with `.git` and a trailing slash allowed after it. */
function repositoryAt(host: string, path: string): GitHubRepository | undefined {
	const parsedHost = parseGitHubHost(host.toLowerCase());
	if (!parsedHost.ok || !KNOWN_HOSTS.has(parsedHost.value)) return undefined;
	const match = /^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(path);
	if (match === null) return undefined;
	const owner = parseGitHubOwner(match[1] ?? '');
	const name = parseGitHubRepositoryName(match[2] ?? '');
	return owner.ok && name.ok
		? { host: parsedHost.value, owner: owner.value, name: name.value }
		: undefined;
}

/**
 * The GitHub repository a remote's address names, or undefined when it is not
 * one: `https://github.com/owner/name(.git)`, `ssh://git@github.com/owner/name.git`,
 * `git@github.com:owner/name.git` and `git://github.com/owner/name.git`.
 */
export function gitHubRepositoryOf(url: string): GitHubRepository | undefined {
	const text = url.trim();
	const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(text);
	if (scp !== null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
		return repositoryAt(scp[1] ?? '', scp[2] ?? '');
	}
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		return undefined;
	}
	if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(parsed.protocol)) {
		return undefined;
	}
	if (parsed.search !== '' || parsed.hash !== '') return undefined;
	return repositoryAt(parsed.hostname, decodeURIComponent(parsed.pathname));
}

/**
 * The remote whose pull requests a local repository's Delves are of: `origin`
 * when it points at GitHub, or else the first remote by name that does; or
 * undefined when none does, and the repository offers no pull requests.
 */
export function pickGitHubRemote(
	remotes: readonly RemoteAddress[]
): { readonly remote: RemoteName; readonly repository: GitHubRepository } | undefined {
	const onGitHub = remotes
		.flatMap((r) => {
			const repository = gitHubRepositoryOf(r.url);
			return repository === undefined ? [] : [{ remote: r.remote, repository }];
		})
		.sort((a, b) => (a.remote < b.remote ? -1 : a.remote > b.remote ? 1 : 0));
	return onGitHub.find((r) => r.remote === 'origin') ?? onGitHub[0];
}

/** Whether two are the same repository: GitHub compares owners and names in any case. */
export function sameGitHubRepository(a: GitHubRepository, b: GitHubRepository): boolean {
	return (
		a.host === b.host &&
		a.owner.toLowerCase() === b.owner.toLowerCase() &&
		a.name.toLowerCase() === b.name.toLowerCase()
	);
}

/** The repository as GitHub names it: `owner/name`. */
export function gitHubRepositoryText(repository: GitHubRepository): string {
	return `${repository.owner}/${repository.name}`;
}
