import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import SQLite, { Database } from 'better-sqlite3';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const DEBUG = !!process.env.DEBUG;
const methods = ['all', 'run', 'get', 'exec'];
const baseDomain = process.env.BASE_DOMAIN;
const dataPath = process.env.DATA_PATH || join(import.meta.dirname, 'data');
const maxDatabases = Math.max(1, Number.parseInt(process.env.MAX_DATABASES || '32', 10) || 32);
const maxBodyBytes = Math.max(1, Number.parseInt(process.env.MAX_BODY_BYTES || '1048576', 10) || 1048576);
const slowQueryMs = Math.max(0, Number.parseInt(process.env.SLOW_QUERY_MS || '1000', 10) || 1000);
const databases = new Map<string, Database>();

export function getDatabase(file: string): Database {
  const fullPath = join(dataPath, file);
  const cached = databases.get(fullPath);

  if (cached) {
    // Map insertion order provides a small LRU without another dependency.
    databases.delete(fullPath);
    databases.set(fullPath, cached);
    return cached;
  }

  const db = new SQLite(fullPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  databases.set(fullPath, db);

  while (databases.size > maxDatabases) {
    const oldest = databases.keys().next().value;
    if (!oldest) break;
    databases.get(oldest)?.close();
    databases.delete(oldest);
  }

  return db;
}

export function closeDatabases() {
  for (const db of databases.values()) db.close();
  databases.clear();
}

export function serve() {
  let server;

  if (baseDomain) {
    server = createServer((req, res) => {
      const hostname = String(req.headers['x-forwarded-host'] || '');
      const subdomain = hostname
        .replace(baseDomain, '')
        .replace('.', '')
        .replace(/[^a-z0-9-]+/g, '');

      if (subdomain) {
        return handleRequest(req, res, subdomain + '.sqlite3');
      }

      res.writeHead(400).end();
    });
  } else {
    server = createServer((req, res) => handleRequest(req, res, 'db.sqlite3'));
  }

  server.listen(+process.env.PORT, () => {
    console.log(`Started on ${process.env.PORT}`);
  });
  server.once('close', closeDatabases);

  return server;
}

export async function handleRequest(request: IncomingMessage, response: ServerResponse, db: string) {
  DEBUG &&
    response.on('finish', () => {
      console.log(
        `[${new Date().toISOString().slice(0, 19)}] [${response.statusCode} ${String(request.headers['x-forwarded-host'] || '')}] ${request.method} ${request.url}`,
      );
    });

  const url = new URL(request.url, 'http://localhost');
  const route = `${request.method} ${url.pathname}`.trim();

  switch (route) {
    case 'GET /console.html':
      const consolePage = await readFile('./console.html', 'utf8');
      response.writeHead(200, { 'content-type': 'text/html' }).end(consolePage);
      return;

    case 'GET /logo.svg':
      const logo = await readFile('./logo.svg', 'utf8');
      response.writeHead(200, { 'content-type': 'image/svg+xml' }).end(logo);
      return;

    case 'GET /index.mjs':
      return onEsModule(request, response);

    case 'GET /schema':
      return onSchema(response, db, url.searchParams.get('internal') === '1');

    case 'POST /query':
      return onQuery(request, response, db);

    default:
      response.writeHead(404).end();
  }
}

async function onSchema(
  response: ServerResponse,
  db: string,
  includeInternal: boolean,
) {
  try {
    const sqlite = getDatabase(db);
    const schema = getSchema(sqlite, includeInternal);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(schema));
  } catch (error) {
    DEBUG && console.error(error);
    response.writeHead(400).end(String(error));
  }
}

function getSchema(sqlite: Database, includeInternal: boolean) {
  const objects = sqlite
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE sql IS NOT NULL
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name`,
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  const tables = sqlite.pragma('table_list') as Array<{
    schema: string;
    name: string;
    type: string;
    ncol: number;
    wr: number;
    strict: number;
  }>;

  const visibleTables = tables.filter((table) => includeInternal || !table.name.startsWith('sqlite_'));
  const details = visibleTables.map((table) => {
    const columns = sqlite.pragma(`table_xinfo(${quotePragmaValue(table.name)})`);
    const tableObjects = objects.filter((object) => object.tbl_name === table.name);
    const indexes = table.type === 'table'
      ? (sqlite.pragma(`index_list(${quotePragmaValue(table.name)})`) as Array<{ name: string }>).map((index) => ({
          ...index,
          columns: sqlite.pragma(`index_info(${quotePragmaValue(index.name)})`),
          sql: objects.find((object) => object.type === 'index' && object.name === index.name)?.sql || null,
        }))
      : [];

    return {
      ...table,
      sql: objects.find((object) => object.type === 'table' && object.name === table.name)?.sql || null,
      columns,
      indexes,
      foreignKeys: table.type === 'table' ? sqlite.pragma(`foreign_key_list(${quotePragmaValue(table.name)})`) : [],
      objects: tableObjects,
    };
  });

  return {
    tables: details,
    objects: includeInternal ? objects : objects.filter((object) => !object.name.startsWith('sqlite_')),
    statements: (includeInternal ? objects : objects.filter((object) => !object.name.startsWith('sqlite_'))).map(
      (object) => object.sql,
    ),
  };
}

function quotePragmaValue(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function onQuery(request: IncomingMessage, response: ServerResponse, db: string) {
  const query = await readBody(request);

  if (!query) {
    response.writeHead(413).end('Request body too large.');
    return;
  }

  if (!query.length) {
    response.writeHead(400).end();
    return;
  }

  try {
    const { s = '', d, m = 'run', p, t } = JSON.parse(query.toString('utf-8'));

    if (t !== undefined) {
      if (!Array.isArray(t) || !t.length) throw new Error('Invalid transaction.');

      const sqlite = getDatabase(db);
      applyPragmas(sqlite, p);
      const started = performance.now();
      const result = sqlite.transaction(() => t.map((statement) => executeStatement(sqlite, statement)))();
      logSlowQuery(started, `transaction (${t.length} statements)`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
      return;
    }

    if (!s.trim()) {
      throw new Error('Invalid statement.');
    }

    if (!methods.includes(m)) {
      throw new Error('Invalid method. Must be one of ' + methods.join(', '));
    }

    const sqlite = getDatabase(db);
    applyPragmas(sqlite, p);
    const started = performance.now();
    const result = executeStatement(sqlite, { s, d, m });
    logSlowQuery(started, s.trim());

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result ?? null));
    DEBUG && console.log(s.trim(), d, result);
  } catch (error) {
    DEBUG && console.error(error);
    const status = (error as { code?: string }).code === 'SQLITE_BUSY' ? 503 : 400;
    response.writeHead(status).end(String(error));
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      request.resume();
      return null;
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function applyPragmas(sqlite: Database, pragmas: unknown) {
  if (Array.isArray(pragmas) && pragmas.every((value) => typeof value === 'string')) {
    for (const pragma of pragmas) sqlite.pragma(pragma);
  }
}

function executeStatement(sqlite: Database, statement: { s?: unknown; d?: unknown; m?: unknown }) {
  const sql = statement.s;
  const method = String(statement.m || 'run');

  if (typeof sql !== 'string' || !sql.trim() || !methods.includes(String(method))) {
    throw new Error('Invalid transaction statement.');
  }

  if (method === 'exec') return sqlite.exec(sql.trim());

  const runner = sqlite.prepare(sql.trim());
  const execute = (runner as unknown as Record<string, (data?: unknown) => unknown>)[method];
  return statement.d === undefined ? execute.call(runner) : execute.call(runner, statement.d);
}

function logSlowQuery(started: number, statement: string) {
  const duration = performance.now() - started;
  if (DEBUG && duration >= slowQueryMs) {
    console.log(`Slow query (${Math.round(duration)}ms):`, statement);
  }
}

async function onEsModule(request: IncomingMessage, response: ServerResponse) {
  const hostname = String(request.headers['x-forwarded-host']);
  const code = await readFile('./client.mjs', 'utf8');

  response
    .writeHead(200, {
      'Content-Type': 'text/javascript',
      'Access-Control-Allow-Origin': '*',
    })
    .end(code.replace('__API_URL__', hostname));
}
