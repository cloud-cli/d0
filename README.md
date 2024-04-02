# d0

SQLite server over HTTP

## Usage

**POST /query**

Run a prepared SQLite statement.
Send a JSON with two properties: `s` for statement and `d` for data (optional)

```js
// using fetch
fetch('https://db.example.com/query', {
  body: JSON.stringify({
    s: 'SELECT * FROM user WHERE id = ?',
    d: [123]
  });
});

// using the server-provided library
import db from 'https://db.example.com/index.mjs';

const user = await db.query('SELECT * FROM user WHERE id = ?', [123]);
```

## Environment variables

| Variable       | Description                                       |
|-|-|
| PORT           | HTTP port                                         |
| SQLITE_DB_PATH | Path to file where the database files are stored  |