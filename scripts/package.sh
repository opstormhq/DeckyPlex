#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
repo_dir="$PWD"
staging_dir="$(mktemp -d)"
trap 'rm -rf "$staging_dir"' EXIT
plugin_dir="$staging_dir/DeckyPlex"

mkdir -p "$plugin_dir/dist" "$plugin_dir/assets" "$plugin_dir/py_modules"
cp dist/index.js "$plugin_dir/dist/"
cp main.py video_pip.py plugin.json package.json LICENSE README.md "$plugin_dir/"
cp assets/game-pip.js node_modules/hls.js/dist/hls.min.js "$plugin_dir/assets/"
cp node_modules/hls.js/LICENSE "$plugin_dir/LICENSE-hls.js"

"${PYTHON:-python3}" -m pip install --require-hashes --only-binary=:all: --platform any \
    --no-compile --target "$plugin_dir/py_modules" -r requirements.txt
# Keep the PlexAPI queue fixes used by the Deck builds with the pinned wheel.
patch -s -f "$plugin_dir/py_modules/plexapi/playqueue.py" "$repo_dir/scripts/patches/plexapi-playqueue.patch"
cp -R py_modules/xml "$plugin_dir/py_modules/"

cd "$staging_dir"
zip -X -qr DeckyPlex.zip DeckyPlex -x '*/__pycache__/*' '*/__pycache__/' '*/.DS_Store' '*/py_modules/bin/*' '*/py_modules/bin/'
mv DeckyPlex.zip "$repo_dir/"
