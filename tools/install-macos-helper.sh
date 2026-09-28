#!/bin/sh
#
# Installs nowplaying-cli (plus the MediaRemote adapter it needs) for QQMusicNow
# on macOS — no Homebrew, no sudo, no Xcode.
#
# Why this exists: the GitHub release ships only a bare binary, but the helper
# needs two companion files next to it to reach MediaRemote on macOS 15+:
#
#   <dest>/nowplaying-cli
#   <dest>/lib/nowplaying-cli/MediaRemoteMini.dylib
#   <dest>/share/nowplaying-cli/scripts/mediaremote-mini.pl
#
# Without them `nowplaying-cli get-raw` silently returns an empty dictionary.
#
# Usage:
#   sh tools/install-macos-helper.sh [dest-dir]     # default: ~/bin
#
set -eu

DEST="${1:-$HOME/bin}"
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this installer is macOS only"

# ---------------------------------------------------------------- bottle pick
case "$(sw_vers -productVersion)" in
  26.*|27.*) tag_arm64="arm64_tahoe" ;;
  15.*)      tag_arm64="arm64_sequoia" ;;
  14.*)      tag_arm64="arm64_sonoma" ;;
  13.*)      tag_arm64="arm64_ventura" ;;
  *)         tag_arm64="arm64_sequoia" ;;
esac
case "$(uname -m)" in
  arm64) tag="$tag_arm64" ;;
  x86_64) tag="sonoma" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/qqmusicnow-helper.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

say "==> resolving Homebrew bottle for $tag"
curl -fsSL --max-time 60 -o "$TMP_DIR/formula.json" \
  https://formulae.brew.sh/api/formula/nowplaying-cli.json

BOTTLE_URL=$(plutil -extract "bottle.stable.files.$tag.url" raw -o - "$TMP_DIR/formula.json")
BOTTLE_SHA=$(plutil -extract "bottle.stable.files.$tag.sha256" raw -o - "$TMP_DIR/formula.json")
VERSION=$(plutil -extract "versions.stable" raw -o - "$TMP_DIR/formula.json")
[ -n "$BOTTLE_URL" ] || die "no bottle published for $tag"
say "    version $VERSION"

# ------------------------------------------------------------------ download
say "==> downloading bottle"
TOKEN=$(curl -fsSL --max-time 60 \
  "https://ghcr.io/token?service=ghcr.io&scope=repository:homebrew/core/nowplaying-cli:pull" \
  | plutil -extract token raw -o - -)
curl -fsSL --max-time 300 -H "Authorization: Bearer $TOKEN" -o "$TMP_DIR/bottle.tar.gz" "$BOTTLE_URL"

ACTUAL_SHA=$(shasum -a 256 "$TMP_DIR/bottle.tar.gz" | awk '{print $1}')
[ "$ACTUAL_SHA" = "$BOTTLE_SHA" ] || die "checksum mismatch (expected $BOTTLE_SHA, got $ACTUAL_SHA)"
say "    checksum ok"

mkdir -p "$TMP_DIR/extract"
tar -xzf "$TMP_DIR/bottle.tar.gz" -C "$TMP_DIR/extract"
BOTTLE_BIN=$(find "$TMP_DIR/extract" -type f -name 'nowplaying-cli' | head -1)
[ -n "$BOTTLE_BIN" ] || die "unexpected bottle layout (no binary found)"
SRC=$(dirname "$(dirname "$BOTTLE_BIN")")

# ------------------------------------------------------------------- install
# Stage inside $DEST, then rename into place. Renaming gives a fresh inode;
# overwriting a binary in place can leave macOS rejecting it with
# "Code Signature Invalid" (SIGKILL) until the inode changes.
say "==> installing into $DEST"
mkdir -p "$DEST/lib/nowplaying-cli" "$DEST/share/nowplaying-cli/scripts"
STAGE="$DEST/.install.$$"
mkdir -p "$STAGE" "$STAGE/lib/nowplaying-cli" "$STAGE/share/nowplaying-cli/scripts"

cp "$SRC/bin/nowplaying-cli" "$STAGE/nowplaying-cli"
cp "$SRC/lib/nowplaying-cli/MediaRemoteMini.dylib" "$STAGE/lib/nowplaying-cli/MediaRemoteMini.dylib"
cp "$SRC/share/nowplaying-cli/scripts/mediaremote-mini.pl" "$STAGE/share/nowplaying-cli/scripts/mediaremote-mini.pl"
chmod 755 "$STAGE/nowplaying-cli" "$STAGE/share/nowplaying-cli/scripts/mediaremote-mini.pl"
chmod 644 "$STAGE/lib/nowplaying-cli/MediaRemoteMini.dylib"

mv -f "$STAGE/nowplaying-cli" "$DEST/nowplaying-cli"
mv -f "$STAGE/lib/nowplaying-cli/MediaRemoteMini.dylib" "$DEST/lib/nowplaying-cli/MediaRemoteMini.dylib"
mv -f "$STAGE/share/nowplaying-cli/scripts/mediaremote-mini.pl" "$DEST/share/nowplaying-cli/scripts/mediaremote-mini.pl"
rmdir "$STAGE/lib/nowplaying-cli" "$STAGE/lib" "$STAGE/share/nowplaying-cli/scripts" "$STAGE/share/nowplaying-cli" "$STAGE/share" "$STAGE"

codesign --verify --verbose=1 "$DEST/nowplaying-cli" 2>&1 | sed 's/^/    /'

# ------------------------------------------------------------------- verify
say "==> probing (start playback if this says no track)"
OUT=$("$DEST/nowplaying-cli" get title artist 2>/dev/null || true)
if [ -n "$OUT" ]; then
  say "    $OUT" | tr '\n' ' '
  say ""
else
  say "    no track reported yet — play something in QQ Music and rerun."
fi

say ""
say "done. QQMusicNow finds the helper automatically in ~/bin."
say "source: $SELF_DIR"
