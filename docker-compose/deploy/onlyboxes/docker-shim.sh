#!/usr/bin/env bash
# `docker` for onlyboxes-worker-docker (installed as /opt/onlyboxes/shim/docker, first on
# the worker's PATH). worker-docker has no cgroup option, so this puts every container it
# creates into onlyboxes.slice; everything else passes through unchanged.
# Onlyboxes-guard removes any managed container found outside the slice, so a worker
# upgrade that changes how it calls `docker create` fails closed.
set -euo pipefail

REAL_DOCKER=/usr/bin/docker
SLICE="${ONLYBOXES_SLICE:-onlyboxes.slice}"

if [[ "${1:-}" == "create" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "onlyboxes.managed=true" ]]; then
      shift
      exec "$REAL_DOCKER" create --cgroup-parent "$SLICE" "$@"
    fi
  done
fi
exec "$REAL_DOCKER" "$@"
