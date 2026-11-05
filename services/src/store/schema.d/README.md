# Feature tables

Each `.sql` file here runs after `../schema.sql`, in name order, on every start. Use `CREATE TABLE IF NOT EXISTS`
and `ADD COLUMN IF NOT EXISTS` so running it again changes nothing, and name the file after the plugin that owns it.
