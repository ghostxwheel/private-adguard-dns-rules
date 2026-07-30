#!/bin/sh
# Entrypoint for the hostlist-compiler container on the Radxa. Invoked by
# Ofelia (ofelia.job-exec, see docker-compose.yml in this folder) inside the
# already-running container, same pattern as feed-deluge/sync-withings on
# the node-red container.
#
# Lives in the repo itself (not baked into the Docker image) so pulling the
# latest commit also picks up any changes to this script or to
# scripts/fetch-remote-rules.js, scripts/normalize-blacklist.js,
# configuration.json - no image rebuild needed to change pipeline behavior.
set -eu

REPO_DIR="/data/repo"
REPO_URL="https://github.com/ghostxwheel/private-adguard-dns-rules.git"

if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"
git fetch origin main
git reset --hard origin/main

npm install

rm -rf hostlists
mkdir -p hostlists

node scripts/fetch-remote-rules.js
npx hostlist-compiler -c configuration.json -o dns-blacklist.txt
node scripts/normalize-blacklist.js

git config user.name "radxa-hostlist-bot"
git config user.email "radxa-hostlist-bot@localhost"

git add dns-blacklist.txt

if git diff --cached --quiet; then
  echo "No changes detected in dns-blacklist.txt, skipping commit."
else
  git commit -m "Update dns-blacklist.txt"

  if [ -n "${GITHUB_TOKEN:-}" ]; then
    git push "https://x-access-token:${GITHUB_TOKEN}@github.com/ghostxwheel/private-adguard-dns-rules.git" HEAD:main
  else
    echo "GITHUB_TOKEN not set - commit created locally but not pushed" >&2
    exit 1
  fi
fi
