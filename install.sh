#!/usr/bin/env bash
# Install (or reinstall) the dsh `/ask` command into a dsh profile.
#
# Both faces are copied beside the profile rather than referenced in place, so
# the host half's `@deepseek-ai/*` imports resolve through the profile's own
# node_modules (Node resolves bare specifiers from the importing file's
# directory upward).
#
# The registration goes in the HOME-level patch layer, not the profile's: it applies
# to every profile, and a profile created or re-templated later cannot lose it. A layer holding
# only this plugin's own block is replaced; a layer holding anything else is
# backed up and appended to.
#
# NOTE: the host keeps two process-lifetime caches that this layout defeats by
# construction — Node's ES module cache (the Loader imports a row by URL with no
# cache-busting query, so a fixed filename keeps executing the code it first
# imported) and the client-module scan's `dsh.client` cache (keyed by
# base+specifier). The host entry is therefore content-addressed; see
# "Two host caches" in README.md.
#
# Usage: bash install.sh [profile-name]     # default: web
set -euo pipefail

PROFILE_NAME="${1:-web}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/workspace/.dsh}"
PROFILE="$DSH_HOME_DIR/profiles/$PROFILE_NAME"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$PROFILE/plugins/ask-panel"

if [ ! -d "$PROFILE" ]; then
    echo "install.sh: no such profile: $PROFILE" >&2
    exit 1
fi

# Content-addressed host entry.
#
# The Loader imports a row by URL and Node caches ES modules by URL for the
# whole process lifetime — `@@deepseek-ai/cordis-plugin-loader` calls
# `import(name)` with no cache-busting query. A fixed filename therefore means
# every reload keeps executing the module it first imported. Hashing the content
# makes a real edit a new URL (a fresh import) while an unchanged file stays a
# correct cache hit. It also changes the row's specifier, which is what the
# client-module scan keys its own per-process `dsh.client` cache on.
HOST_HASH="$(sha1sum "$SRC/host.js" | cut -c1-10)"
HOST_FILE="host.${HOST_HASH}.js"

# Replace the plugin directory outright so a superseded entry never lingers for
# the Loader to keep importing.
rm -rf "$PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"
cp "$SRC/host.js" "$PLUGIN_DIR/$HOST_FILE"
cp "$SRC/implementation.js" "$PLUGIN_DIR/implementation.js"
cp "$SRC/patch-layout.js" "$PLUGIN_DIR/patch-layout.js"
cp "$SRC/client.js" "$PLUGIN_DIR/client.js"
cp "$SRC/package.json" "$PLUGIN_DIR/package.json"

PATCH="$DSH_HOME_DIR/cordis.patch.yml"
BODY=""
[ -f "$PATCH" ] && BODY="$(sed -e 's/#.*$//' -e '/^[[:space:]]*$/d' "$PATCH")"
# "Ours" is decided per ROW, not by a keyword: a rename changed the plugin
# directory name once and a keyword test then appended a second row on every
# install, leaving dead rows that pointed at deleted files and stopped the whole
# layer from applying.
ours="$(printf '%s\n' "$BODY" | grep -cE '^[[:space:]]*name:.*/plugins/(ask-panel|command-btw)/' || true)"
foreign="$(printf '%s\n' "$BODY" | grep -E '^[[:space:]]*name:' | grep -vcE '/plugins/(ask-panel|command-btw)/' || true)"

backup() {
    cp "$PATCH" "$PATCH.bak-$(date +%Y%m%d%H%M%S)"
    echo "backed up previous patch layer"
}

# The client half keeps a stable filename: the host re-reads its bytes and
# addresses them by a content revision the browser fetches.
render_patch() {
    # Absolute on purpose: `dsh-app-boot` anchors a relative name beside the PATCH
    # FILE, and this patch lives at $DSH_HOME while the plugin lives under the
    # profile. A relative name here would resolve to a path that does not exist.
    sed -e "s|__HOST__|$PLUGIN_DIR/$HOST_FILE|g" "$SRC/cordis.patch.yml"
}

# Replace only when the layer is empty or holds nothing but our own single row;
# any other content means the user owns this file and we append instead.
if [ ! -f "$PATCH" ] || [ "$BODY" = "[]" ] || { [ "$ours" -ge 1 ] && [ "$foreign" -eq 0 ]; }; then
    [ -f "$PATCH" ] && backup
    render_patch > "$PATCH"
    echo "wrote patch layer -> $PATCH"
else
    backup
    {
        echo ''
        echo '# --- dsh-ask-panel (appended by install.sh) ---'
        render_patch
    } >> "$PATCH"
    echo "appended ask-panel to existing patch layer -> $PATCH"
fi

# The right column's width is per-page-load memory in the shell, and a plugin
# cannot set it (ILayout has no width setter), so it is patched where it lives.
# Idempotent and backed up; see patch-layout.py for the two edits.
python3 "$SRC/patch-layout.py" "$DSH_HOME_DIR" || echo "install.sh: layout patch skipped" >&2

echo "installed /ask into profile '$PROFILE_NAME'"
echo "  host:   $PLUGIN_DIR/$HOST_FILE (shell)"
echo "  impl:   $PLUGIN_DIR/implementation.js (re-read per invocation)"
echo "  client: $PLUGIN_DIR/client.js"
echo "  patch:  $PATCH"
echo
echo "The host half hot-reloads. The browser half needs a PAGE REFRESH."
