# d0

SQLite server over HTTP

## Usage

**POST /query**

Run a prepared SQLite statement.
Accepts a JSON with these properties:

| Property | Description | Required |
|-|:-:|-|
|`s` | string with the statement | **yes** |
|`d` | data to bind on a statement | no |
|`m` | method to execute: `all`, `run` or `get`. Run is the default | no |

```js
// select all items using fetch
fetch('https://db.example.com/query', {
  method: 'POST',
  body: JSON.stringify({
    s: 'SELECT * FROM user WHERE id = ?',
    d: [123],
    m: 'all',
  });
});

// select using the server-provided library
import db from 'https://db.example.com/index.mjs';

const user = await db.query('SELECT * FROM user WHERE id = ?', [123]);
```

## Server address

If `BASE_DOMAIN` is set, the server will be available at `https://db-name.BASE_DOMAIN/` with a multi-database support, where `db-name` is the name of the database file without the `.sqlite` extension. The database is selected by the `db-name` part of the URL, so you can have multiple databases on the same server.

Otherwise, it will be available at `http://localhost:PORT/` and serve a single database.

## Environment variables

| Variable       | Description                                                  |
|-|-|
| PORT           | HTTP port                                                    |
| DATA_PATH      | Path to a folder where the database files are stored         |
| BASE_DOMAIN    | Root domain to use in a multi-db server, e.g. `.example.com` |
