#!/bin/sh
# Starts the server as the unprivileged "node" user.
#
# Hosting platforms usually mount the data volume owned by root, which the
# "node" user cannot write to. So, while still root, hand the database folder
# to "node", then drop root for good before starting the server.
set -e

DATA_DIR=$(dirname "${DATABASE_PATH:-/data/webhook-signer.db}")

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
