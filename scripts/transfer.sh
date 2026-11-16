#!/bin/sh
# Copies every ref of each course repo from the old server to the Cloudflare Worker.
# Usage: GIT_TOKEN=... scripts/transfer.sh <old base URL> <new base URL>
# SELFGIT_REPOS overrides the "old:new" name pairs (default repo1:repo1 ... repo10:repo10).
set -eu

old=${1:?old base URL, for example https://selfgit.up.railway.app}
new=${2:?new base URL, for example https://git.oliinyk.dev}
: "${GIT_TOKEN:?set GIT_TOKEN to the push token of the new server}"
pairs=${SELFGIT_REPOS:-"repo1:repo1 repo2:repo2 repo3:repo3 repo4:repo4 repo5:repo5 repo6:repo6 repo7:repo7 repo8:repo8 repo9:repo9 repo10:repo10"}

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# The helper reads the token from the environment, so it never appears in argv or a URL.
helper='!f() { test "$1" = get && echo username=git && echo "password=$GIT_TOKEN"; }; f'

for pair in $pairs; do
  from=${pair%%:*}
  to=${pair#*:}
  echo "== $from -> $to"
  git clone --quiet --mirror "$old/$from.git" "$scratch/$from.git"
  if [ -z "$(git -C "$scratch/$from.git" for-each-ref)" ]; then
    echo "   empty, skipped"
    continue
  fi
  git -C "$scratch/$from.git" -c credential.helper= -c "credential.helper=$helper" push --quiet --mirror "$new/$to.git"
  git -C "$scratch/$from.git" for-each-ref --format='%(objectname) %(refname)' | sort > "$scratch/old.refs"
  git ls-remote "$new/$to.git" | awk '$2 != "HEAD" && $2 !~ /\^\{\}$/ { print $1 " " $2 }' | sort > "$scratch/new.refs"
  if ! cmp -s "$scratch/old.refs" "$scratch/new.refs"; then
    echo "   ref mismatch after push:" >&2
    diff "$scratch/old.refs" "$scratch/new.refs" >&2 || true
    exit 1
  fi
  echo "   $(wc -l < "$scratch/old.refs") refs verified"
done
