/** A local repository's remotes on GitHub, read from its config without the network. */
import {
	gitHubRemotes,
	pickGitHubRemote,
	type GitHubRemote,
	type RemoteAddress
} from '#lib/core/github/github-repository.ts';
import { parseRemoteName } from '#lib/core/history/remote-name.tiny.ts';
import { map, ok, type Result } from '#lib/core/result.ts';
import { gitCwd, gitIn, type GitSourceError, type LocalRepository } from '../git/index.ts';

/**
 * Every remote's address, as git fetches from it, with the person's
 * `url.<base>.insteadOf` applied.
 */
async function remoteAddresses(
	repo: LocalRepository
): Promise<Result<readonly RemoteAddress[], GitSourceError>> {
	const listed = await gitIn(repo, gitCwd(repo), ['remote', '-v']);
	if (!listed.ok) return listed;
	const remotes: RemoteAddress[] = [];
	for (const line of listed.value.stdout.toString('utf8').split('\n')) {
		const match = /^(\S+)\t(.*) \(fetch\)$/.exec(line);
		const name = parseRemoteName(match?.[1] ?? '');
		if (match !== null && name.ok) remotes.push({ remote: name.value, url: match[2] ?? '' });
	}
	return ok(remotes);
}

/**
 * The repository's remote whose pull requests it offers (`upstream`, then
 * `origin`, first: `pickGitHubRemote`) and the GitHub repository it is, or
 * undefined when no remote is on GitHub.
 */
export async function gitHubRemoteOf(
	repo: LocalRepository
): Promise<Result<GitHubRemote | undefined, GitSourceError>> {
	return map(await remoteAddresses(repo), pickGitHubRemote);
}

/** Every remote of the repository on GitHub: a pull request of any of them opens from it. */
export async function gitHubRemotesOf(
	repo: LocalRepository
): Promise<Result<readonly GitHubRemote[], GitSourceError>> {
	return map(await remoteAddresses(repo), gitHubRemotes);
}
