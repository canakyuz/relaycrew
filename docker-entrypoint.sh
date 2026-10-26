#!/bin/sh
set -e

if [ -z "${RELAYCREW_SPLIT_STDERR-${TEAMROUTER_SPLIT_STDERR-${TEAMCLAUDE_SPLIT_STDERR-}}}" ]; then
    exec 2>&1
fi

log() {
    echo "[relaycrew] $*"
}

DEFAULT_UID=1000
DEFAULT_GID=1000
RELAYCREW_CONFIG="${RELAYCREW_CONFIG-${TEAMROUTER_CONFIG-${TEAMCLAUDE_CONFIG-}}}"
if [ -z "$RELAYCREW_CONFIG" ]; then
    RELAYCREW_CONFIG=/data/relaycrew.json
    for name in relaycrew teamrouter teamclaude; do
        if [ -f "/data/$name.json" ]; then RELAYCREW_CONFIG="/data/$name.json"; break; fi
    done
fi
RELAYCREW_HOST="${RELAYCREW_HOST-${TEAMROUTER_HOST-${TEAMCLAUDE_HOST-0.0.0.0}}}"
RELAYCREW_UID="${RELAYCREW_UID-${TEAMROUTER_UID-${TEAMCLAUDE_UID-}}}"
RELAYCREW_GID="${RELAYCREW_GID-${TEAMROUTER_GID-${TEAMCLAUDE_GID-}}}"
export RELAYCREW_CONFIG RELAYCREW_HOST
CONFIG="$RELAYCREW_CONFIG"

if [ "$(id -u)" != "0" ]; then
    exec "$@"
fi

if [ -n "$RELAYCREW_UID" ]; then
    TARGET_UID="$RELAYCREW_UID"
    TARGET_GID="${RELAYCREW_GID:-$RELAYCREW_UID}"
elif [ -e "$CONFIG" ]; then
    TARGET_UID="$(stat -c %u "$CONFIG")"
    TARGET_GID="$(stat -c %g "$CONFIG")"
elif [ -d /data ] && [ "$(stat -c %u /data)" != "0" ]; then
    TARGET_UID="$(stat -c %u /data)"
    TARGET_GID="$(stat -c %g /data)"
else
    TARGET_UID="$DEFAULT_UID"
    TARGET_GID="$DEFAULT_GID"
fi

if [ "$TARGET_UID" = "0" ]; then
    log "warning: running as root"
    exec /sbin/tini -- "$@"
fi

if [ ! -d /data ]; then
    mkdir -p /data
fi
if [ "$(stat -c %u /data)" != "$TARGET_UID" ]; then
    chown "$TARGET_UID:$TARGET_GID" /data 2>/dev/null \
        || log "warning: could not chown /data; relying on mount ownership"
fi

if [ "$TARGET_UID" = "$DEFAULT_UID" ]; then
    RUN_AS="node"
else
    RUN_AS="$TARGET_UID:$TARGET_GID"
fi

export HOME=/data

log "starting as uid=$TARGET_UID gid=$TARGET_GID home=$HOME config=$CONFIG"

exec su-exec "$RUN_AS" /sbin/tini -- "$@"
