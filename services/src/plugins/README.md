# Plugins

Each `.ts` file here default-exports one `Plugin` (see `../plugins.ts`): extra API routes, extra bot commands, or
both. Its tables go in `../store/schema.d/<name>.sql`. Files load in name order at startup, on every role.

A feature added this way only adds files, so feature branches don't edit the same lines and rebase onto main
cleanly.
