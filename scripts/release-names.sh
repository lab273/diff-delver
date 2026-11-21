#!/usr/bin/env bash
# Lists the names a release could clash with, for scripts/release-preflight.ts,
# in .github/workflows/release.yml: the repository's tags, from the remote, and
# the tags of its releases. Both the first job and the releasing job run it, so
# the two checks see the names the same way.
#
# GitHub lists draft releases only to a token that may write, so the first job,
# which may only read, sees published releases, and the releasing job sees
# drafts too.
#
# Input, from the environment:
#   GH_TOKEN, GH_REPO  for gh, as the workflow sets them
#   TAGS_FILE          where to write the tags, one per line
#   RELEASES_FILE      where to write the releases' tags, one per line
#
# Any failure fails the script, so a listing that could not be made is never
# taken for an empty one.
set -euo pipefail

tags=$(git ls-remote --tags --refs origin)
printf '%s\n' "$tags" | sed -n 's|.*refs/tags/||p' > "$TAGS_FILE"
gh release list --limit 1000 --json tagName --jq '.[].tagName' > "$RELEASES_FILE"
