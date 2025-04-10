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

## Environment variables

| Variable       | Description                                       |
|-|-|
| PORT           | HTTP port                                         |
| SQLITE_DB_PATH | Path to file where the database files are stored  |