#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
. "$root/scripts/core-configuration"
tas_install_core_configuration "$root"
"$root/scripts/cleanup-stale" || :
