#!/bin/sh
# Local Postgres for development. Listens on 127.0.0.1:15432 only, with no password. Never use this setup in production.
root="$(cd "$(dirname "$0")/.." && pwd)"
pg="$root/.tools/postgres/18.6.0/bin"
data="$root/.tools/pgdata"
case "$1" in
  start) "$pg/pg_ctl" -D "$data" -l "$root/.tools/postgres.log" -w start ;;
  stop) "$pg/pg_ctl" -D "$data" -m fast -w stop ;;
  *) echo "usage: tools/dev-db.sh start|stop"; exit 1 ;;
esac
