#!/usr/bin/env bash
# Install a released plugin on this machine from its <entry>/vX.Y.Z tag.
#
#   scripts/install-release.sh <entry> [version]     # e.g. work-board, or work-board 0.59.4
#
# Builds the tagged plugin into $BB_PLUGIN_RELEASES/<entry>-<version> (default: a `releases`
# directory next to the repository checkout) and installs that path. Settings are kept: bb
# moves an existing path install of the same plugin id to the new path. bb refuses to replace
# a git:, npm: or builtin install, and this script never removes a plugin.
# The release directory must stay on disk while that version is installed.
set -euo pipefail

entry=${1:?usage: $0 <entry> [version]}
repo=$(git rev-parse --show-toplevel)
cd "$repo"
git fetch -q origin --tags

if [ -n "${2:-}" ]; then
  tag="$entry/v${2#v}"
else
  tag=$(git tag -l "$entry/v*" --sort=-v:refname | head -1)
fi
if [ -z "$tag" ] || ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "no release tag ${tag:-$entry/v*}; CI creates it after the version bump reaches main" >&2
  exit 1
fi

src=$(git show "$tag:.bb/plugins.json" | python3 -c '
import json, sys
print(next(e["source"] for e in json.load(sys.stdin)["plugins"] if e["name"] == sys.argv[1]))
' "$entry")
src=${src#./}

common=$(git rev-parse --path-format=absolute --git-common-dir)
releases=${BB_PLUGIN_RELEASES:-$(dirname "$(dirname "$common")")/releases}
dest="$releases/$entry-${tag##*/v}"
if [ -e "$dest" ]; then
  echo "$dest already exists; it may be the installed release, so it is left as is" >&2
  exit 1
fi

mkdir -p "$dest"
trap 'echo "failed; removing unfinished $dest" >&2; rm -rf "$dest"' ERR
git archive "$tag" "$src" | tar -x -C "$dest" --strip-components="$(tr -cd / <<<"$src/" | wc -c)"
cd "$dest"
if [ -f bun.lock ]; then bun install --frozen-lockfile; else npm ci --include=dev; fi
bb plugin build .
trap - ERR

bb plugin install "$dest" --yes
echo "installed $tag from $dest"
