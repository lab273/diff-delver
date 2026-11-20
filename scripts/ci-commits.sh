#!/usr/bin/env bash
# Lists the commits a push to main must verify, for .github/workflows/verify.yml,
# and splits them into batches for the job matrix. Every commit that reaches main
# is verified on its own (README, "How we work").
#
# Input, from the environment:
#   EVENT     the GitHub event name: push or workflow_dispatch
#   BEFORE    the branch's commit before the push; empty or all zeros for a new branch
#   AFTER     the branch's commit after the push
#   BRANCH    the pushed branch, such as main
#   REMOTE    the remote the checkout fetched from, such as origin
#   MAX_JOBS  the most batches to make (GitHub allows 256 jobs in a matrix)
#   GITHUB_OUTPUT  when set, the file the batches are also written to, as the
#             step output `batches`, once the listing has succeeded
#
# Which commits:
#   - A manual run verifies the head commit.
#   - A push whose old head is known verifies BEFORE..AFTER, which is also right
#     for a force push: the commits that replaced the old ones.
#   - A first push, or a force push whose old head cannot be fetched, verifies
#     every commit of AFTER that no other branch of the remote has. Tags do not
#     count: a tag pushed with the branch points at commits that are new too.
#   - When that leaves nothing (the commits were already elsewhere), the head.
#
# Output: on stdout, a JSON list of batches, oldest commits first:
#   [{"name": "...", "first": "<id>", "size": 2, "commits": "<id> <id>",
#     "timeout": 30, "depth": 0}, ...]
# With no more commits than MAX_JOBS each batch holds one commit. With more, the
# commits are split into MAX_JOBS batches of nearly equal size, in order.
# `timeout` is the batch's job timeout in minutes: MINUTES_PER_COMMIT for each
# commit, at most GitHub's limit for a job. `depth` is the checkout's fetch
# depth: 1 for a batch of one commit, 0 (all history) for a batch that checks
# out several in turn. The workflow cannot compute either, because GitHub's
# expressions have no arithmetic.
# A readable list goes to stderr. Any failure exits non-zero and writes nothing
# to GITHUB_OUTPUT, so the workflow step fails.
set -euo pipefail

: "${EVENT:?}" "${AFTER:?}" "${BRANCH:?}" "${REMOTE:?}"
BEFORE="${BEFORE:-}"
MAX_JOBS="${MAX_JOBS:-256}"
MINUTES_PER_COMMIT=15
# GitHub cancels a job on a hosted runner after 6 hours whatever its timeout says.
MAX_TIMEOUT=360

known() {
	git cat-file -e "$1^{commit}" 2>/dev/null
}

if ! known "$AFTER"; then
	echo "The pushed head $AFTER is not a commit in this checkout, so there is nothing to verify." >&2
	echo "Check that the checkout step fetched the pushed branch (fetch-depth: 0)." >&2
	exit 1
fi

if [ "$EVENT" = workflow_dispatch ]; then
	commits="$AFTER"
else
	if [ -n "$BEFORE" ] && ! [[ "$BEFORE" =~ ^0+$ ]] && ! known "$BEFORE"; then
		# A force push leaves the old head unreachable, so the checkout did not fetch
		# it. GitHub usually still serves it by id; without it, fall back below.
		git fetch --quiet --no-tags "$REMOTE" "$BEFORE" 2>/dev/null || true
	fi
	if [ -n "$BEFORE" ] && ! [[ "$BEFORE" =~ ^0+$ ]] && known "$BEFORE"; then
		commits="$(git rev-list --reverse "$BEFORE..$AFTER")"
	else
		commits="$(git rev-list --reverse "$AFTER" --not \
			--exclude="$REMOTE/$BRANCH" --remotes="$REMOTE")"
	fi
	if [ -z "$commits" ]; then commits="$AFTER"; fi
fi

mapfile -t list <<<"$commits"
count=${#list[@]}
jobs=$((count < MAX_JOBS ? count : MAX_JOBS))

echo "Commits to verify ($count, in $jobs jobs):" >&2
printf '  %s\n' "${list[@]}" >&2

json='['
for ((job = 0; job < jobs; job += 1)); do
	from=$((job * count / jobs))
	to=$(((job + 1) * count / jobs))
	batch=("${list[@]:from:to-from}")
	size=${#batch[@]}
	first="${batch[0]}"
	if [ "$size" -eq 1 ]; then
		name="$first"
	else
		name="${first:0:12} and $((size - 1)) more"
	fi
	timeout=$((size * MINUTES_PER_COMMIT))
	timeout=$((timeout < MAX_TIMEOUT ? timeout : MAX_TIMEOUT))
	depth=$((size == 1 ? 1 : 0))
	if [ "$job" -gt 0 ]; then json+=','; fi
	json+="$(printf '{"name":"%s","first":"%s","size":%d,"commits":"%s","timeout":%d,"depth":%d}' \
		"$name" "$first" "$size" "${batch[*]}" "$timeout" "$depth")"
done
json+=']'

echo "$json"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
	echo "batches=$json" >>"$GITHUB_OUTPUT"
fi
