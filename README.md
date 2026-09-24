# d0

SQLite server over HTTP

## Usage

**GET /schema**

Inspect the database schema without issuing SQL. The response includes table and view columns, indexes, foreign keys, original `sqlite_schema` objects, and an ordered `statements` array suitable for a basic schema dump or recreation script. SQLite internal objects are excluded by default; request `/schema?internal=1` to include them.

```js
const schema = await db.schema();
console.log(schema.tables, schema.statements);
```

**GET /api** returns an OpenAPI 3.1 description of the HTTP API.

**POST /clone** creates a copy of the selected database. The target name must contain only letters, numbers, and hyphens. An existing target returns `409` until overwrite is explicitly confirmed.

```js
await db.clone('test-copy');
await db.clone('test-copy', true); // overwrite an existing copy
```

Database maintenance is available through the HTTP API only, not the consumer ES module. Restore and cleanup require `{ "confirm": true }`:

- `DELETE /` moves the selected database and its SQLite sidecars into `DATA_PATH/.bin/`.
- `POST /restore` restores the newest quarantined copy for the selected database, if no live database exists.
- `POST /cleanup` removes quarantined copies older than seven days and returns the deleted archive names.

Cleanup also runs automatically when the server starts. Use these endpoints carefully; they are intended for trusted private-cloud automation.

Databases can be selected by subdomain as before, or by a path prefix for longer IDs. For example, `https://example.com/db~test/index.mjs` selects `test.sqlite3`, and `DELETE https://example.com/db~test/` quarantines it. The path prefix must be `/db~<id>` and is only interpreted at the beginning of the pathname.

The web console uses an explicit method selector instead of guessing from SQL text. Use `all` or `get` for reads, `run` for one prepared statement, `exec` for DDL or multiple statements, and `transaction` to run the entered SQL atomically.

**POST /query**

Run a prepared SQLite statement.
Accepts a JSON with these properties:

| Property | Description | Required |
|-|:-:|-|
|`s` | string with the statement | **yes** |
|`d` | data to bind on a statement | no |
|`m` | method to execute: `all`, `run`, `get` or `exec`. Run is the default | no |
|`p` | pragma statements as an array of strings. They run before the query | no |

```js
// select all items using fetch
fetch('https://db.example.com/query', {
  method: 'POST',
  body: JSON.stringify({
    s: 'SELECT * FROM user WHERE id = ?',
    d: [123],
    m: 'all',
    p: ['foreign_keys = ON']
  });
});

// select using the server-provided library
import db from 'https://db.example.com/index.mjs';

const user = await db.query('SELECT * FROM user WHERE id = ?', [123]);

// Execute one or more SQL statements without preparing them
await db.exec('CREATE TABLE IF NOT EXISTS user (id INTEGER PRIMARY KEY)');

// Run several statements atomically; the server owns the transaction lifecycle
await db.transaction([
  { s: 'INSERT INTO user (id) VALUES (?)', d: [123] },
  { s: 'UPDATE user SET id = ? WHERE id = ?', d: [456, 123] }
]);
```

## Server address

If `BASE_DOMAIN` is set, the server will be available at `https://db-name.BASE_DOMAIN/` with a multi-database support, where `db-name` is the name of the database file without the `.sqlite` extension. The database is selected by the `db-name` part of the URL, so you can have multiple databases on the same server.

Otherwise, it will be available at `http://localhost:PORT/` and serve a single database.

## Environment variables

| Variable       | Description                                                  |
|-|-|
| PORT           | HTTP port                                                    |
| DATA_PATH      | Path to a folder where the database files are stored (default: `/home/app/data` in Docker) |
| BASE_DOMAIN    | Root domain to use in a multi-db server, e.g. `.example.com` |
| MAX_DATABASES  | Maximum number of database connections kept open (default: `32`) |
| MAX_BODY_BYTES | Maximum JSON request size (default: `1048576`)                  |

## Development

This project uses pnpm `12.3.4`. The workspace explicitly permits the `better-sqlite3` native install script; it must run during Docker builds so the platform-specific SQLite binding is present in the final image.
