#!/usr/bin/env bash
# Wrapper for operators who prefer a shell entrypoint.
exec node "$(dirname "$0")/tenant-cli.js" create "$@"
