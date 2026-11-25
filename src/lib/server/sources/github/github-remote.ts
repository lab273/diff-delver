/** Which of a local repository's remotes is on GitHub, read from its config without the network. */
import { pickGitHubRemote, type GitHubRepository } from '#lib/core/github/github-repository.ts';
import { parseRemoteName, type RemoteName } from '#lib/core/history/remote-name.tiny.ts';
import { ok, type Result } from '#lib/core/result.ts';
import { gitCwd, gitIn, type GitSourceError, type LocalRepository } from '../git/index.ts';

/**
 * The repository's remote on GitHub (`origin` first) and the GitHub repository
 * it is, or undefined when no remote is on GitHub. The addresses are as git
 * fetches from them, with the person's `url.<base>.insteadOf` applied.
 */
export async function gitHubRemoteOf(
	repo: LocalRepository
): Promise<
	Result<
		{ readonly remote: RemoteName; readonly repository: GitHubRepository } | undefined,
		GitSourceError
	>
> {
	const listed = await gitIn(repo, gitCwd(repo), ['remote', '-v']);
	if (!listed.ok) return listed;
	const remotes: { remote: RemoteName; url: string }[] = [];
	for (const line of listed.value.stdout.toString('utf8').split('\n')) {
		const match = /^(\S+)\t(.*) \(fetch\)$/.exec(line);
		const name = parseRemoteName(match?.[1] ?? '');
		if (match !== null && name.ok) remotes.push({ remote: name.value, url: match[2] ?? '' });
	}
	return ok(pickGitHubRemote(remotes));
}
