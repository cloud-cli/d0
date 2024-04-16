import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import SQLite, { Database } from 'better-sqlite3';

const methods = ['all', 'run', 'get'];

type Q = {
  db: Database;
  request: IncomingMessage;
  response: ServerResponse;
  args: Record<string, string>;
};

export function getDatabase(): Database {
  const db = new SQLite(process.env.SQLITE_DB_PATH || './db.sqlite3');
  db.pragma('journal_mode = WAL');
  return db;
}

export function serve() {
  const db = getDatabase();

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const route = `${request.method} ${url.pathname}`.trim();
    const args = Object.fromEntries(url.searchParams.entries()) as Q['args'];
    const q: Q = { db, request, response, args };

    switch (route) {
      case 'GET /index.mjs':
        return onEsModule(q);

      case 'POST /query':
        return onQuery(q);

      default:
        response.writeHead(404).end();
    }
  });

  server.listen(process.env.PORT);

  return server;
}

async function onQuery({ db, request, response }: Q) {
  const query = await readStream(request);

  if (!query.length) {
    response.writeHead(400).end();
    return;
  }

  try {
    const { s, d, m = 'run' } = JSON.parse(query);
    const runner = db.prepare(s);
    const method = methods.includes(m) ? m : 'run';
    const result = d ? runner[method](d) : runner[method]();
    response.end(JSON.stringify(result));
  } catch (error) {
    process.env.DEBUG && console.error(error);
    response.writeHead(400).end(String(error));
  }
}

let file;
async function getFile() {
  if (!file) {
    file = await readFile('./client.mjs', 'utf8');
  }

  return file;
}

async function onEsModule({ request, response }: Q) {
  const hostname = request.headers['x-forwarded-for'];
  const code = await getFile();

  response
    .writeHead(200, {
      'Content-Type': 'text/javascript',
      'Access-Control-Allow-Origin': '*',
    })
    .end(code.replace('__API_URL__', hostname));
}

function readStream(stream): Promise<string> {
  return new Promise((resolve, reject) => {
    const all = [];
    stream.on('data', (c) => all.push(c));
    stream.on('end', () => resolve(Buffer.concat(all).toString('utf8')));
    stream.on('error', reject);
  });
}
