# d0

SQLite server over HTTP

## Usage

**GET /schema**

Inspect the database schema without issuing SQL. The response includes table and view columns, indexes, foreign keys, original `sqlite_schema` objects, and an ordered `statements` array suitable for a basic schema dump or recreation script. SQLite internal objects are excluded by default; request `/schema?internal=1` to include them.

```js
const schema = await db.schema();
console.log(schema.tables, schema.statements);
```

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
| SLOW_QUERY_MS  | Log slow queries in `DEBUG` mode (default: `1000`)             |

## Development

This project uses pnpm `12.3.4`. The workspace explicitly permits the `better-sqlite3` native install script; it must run during Docker builds so the platform-specific SQLite binding is present in the final image.
