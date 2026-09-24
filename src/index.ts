import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import SQLite, { Database } from 'better-sqlite3';
import { join } from 'node:path';

const DEBUG = !!process.env.DEBUG;
const methods = ['all', 'run', 'get', 'exec'];
const baseDomain = process.env.BASE_DOMAIN;
const dataPath = process.env.DATA_PATH || join(import.meta.dirname, 'data');
const binPath = join(dataPath, '.bin');
const maxDatabases = Math.max(1, Number.parseInt(process.env.MAX_DATABASES || '32', 10) || 32);
const maxBodyBytes = Math.max(1, Number.parseInt(process.env.MAX_BODY_BYTES || '1048576', 10) || 1048576);
const databases = new Map<string, Database>();
const cloneLocks = new Set<string>();

mkdirSync(dataPath, { recursive: true });
mkdirSync(binPath, { recursive: true });
cleanupDeletedDatabases();

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
  const server = createServer((req, res) => {
    const pathDatabase = getPathDatabase(req.url);
    if (pathDatabase) {
      req.url = pathDatabase.url;
      return dispatchRequest(req, res, pathDatabase.file, pathDatabase.prefix);
    }

    if (baseDomain) {
      const hostname = String(req.headers['x-forwarded-host'] || '');
      const subdomain = hostname
        .replace(baseDomain, '')
        .replace('.', '')
        .replace(/[^a-z0-9-]+/g, '');

      if (subdomain) {
        return dispatchRequest(req, res, subdomain + '.sqlite3');
      }

      res.writeHead(400).end();
      return;
    }

    return dispatchRequest(req, res, 'db.sqlite3');
  });

  server.listen(+process.env.PORT, () => {
    console.log(`Started on ${process.env.PORT}`);
  });
  server.once('close', closeDatabases);

  return server;
}

function dispatchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  db: string,
  databasePrefix = '',
) {
  return handleRequest(request, response, db, databasePrefix).catch((error) => {
    DEBUG && console.error('request failed', error);
    if (!response.headersSent) sendError(response, 500, error);
  });
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  db: string,
  databasePrefix = '',
) {
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

    case 'GET /api':
      return onApi(request, response, databasePrefix);

    case 'GET /index.mjs':
      return onEsModule(request, response, databasePrefix);

    case 'GET /schema':
      return onSchema(response, db, url.searchParams.get('internal') === '1');

    case 'POST /query':
      return onQuery(request, response, db);

    case 'POST /clone':
      return onClone(request, response, db);

    case 'DELETE /':
      return onDelete(response, db);

    case 'POST /restore':
      return onRestore(request, response, db);

    case 'POST /cleanup':
      return onCleanup(request, response);

    default:
      response.writeHead(404).end();
  }
}

function onApi(request: IncomingMessage, response: ServerResponse, databasePrefix: string) {
  const host = request.headers['x-forwarded-host'] || request.headers.host;
  const protocol = request.headers['x-forwarded-proto'] || 'http';
  const document = {
    openapi: '3.1.0',
    info: {
      title: 'd0 SQLite API',
      version: '1.0.0',
      description: 'SQLite over HTTPS with prepared statements and schema introspection.',
    },
    ...(host ? { servers: [{ url: `${protocol}://${host}${databasePrefix}` }] } : {}),
    paths: {
      '/query': {
        post: {
          summary: 'Execute SQL',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/QueryRequest' } } },
          },
          responses: {
            '200': { description: 'SQLite result.' },
            '400': { description: 'Invalid SQL or request.' },
            '413': { description: 'Request body too large.' },
            '503': { description: 'SQLite is busy.' },
          },
        },
      },
      '/schema': {
        get: {
          summary: 'Inspect database schema',
          parameters: [
            {
              name: 'internal',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['1'] },
              description: 'Include SQLite internal objects.',
            },
          ],
          responses: { '200': { description: 'Schema metadata.' } },
        },
      },
      '/index.mjs': { get: { summary: 'Get the consumer ES module', responses: { '200': { description: 'JavaScript module.' } } } },
      '/clone': {
        post: {
          summary: 'Clone the selected database',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CloneRequest' } } },
          },
          responses: {
            '201': { description: 'Database cloned.' },
            '400': { description: 'Invalid database name.' },
            '409': { description: 'Target exists and overwrite was not confirmed.' },
            '503': { description: 'Another clone is already running for the target.' },
          },
        },
      },
    },
    components: {
      schemas: {
        QueryRequest: {
          type: 'object',
          properties: {
            s: { type: 'string', description: 'SQL statement.' },
            d: { description: 'Positional or named statement bindings.' },
            m: { type: 'string', enum: ['all', 'get', 'run', 'exec'], default: 'run' },
            p: { type: 'array', items: { type: 'string' }, description: 'Pragmas applied before execution.' },
            t: { type: 'array', items: { $ref: '#/components/schemas/TransactionStatement' } },
          },
          description: 'Use t instead of s to execute an atomic transaction.',
        },
        TransactionStatement: {
          type: 'object',
          required: ['s'],
          properties: {
            s: { type: 'string' },
            d: {},
            m: { type: 'string', enum: ['all', 'get', 'run', 'exec'], default: 'run' },
          },
        },
        CloneRequest: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9-]*$', description: 'Name of the cloned database.' },
            overwrite: { type: 'boolean', default: false, description: 'Replace the target if it already exists.' },
          },
        },
      },
    },
  };

  sendJson(response, 200, document);
}

function getPathDatabase(requestUrl = '') {
  const url = new URL(requestUrl, 'http://localhost');
  const match = url.pathname.match(/^\/db~([a-zA-Z0-9][a-zA-Z0-9_-]*)(\/.*)?$/);
  if (!match) return null;

  const id = match[1];
  return {
    file: `${id}.sqlite3`,
    prefix: `/db~${id}/`,
    url: `${match[2] || '/'}${url.search}`,
  };
}

async function onClone(request: IncomingMessage, response: ServerResponse, source: string) {
  const body = await readBody(request);

  if (!body) {
    sendError(response, 413, new Error('Request body too large.'));
    return;
  }

  try {
    const { name: requestedName, overwrite = false } = JSON.parse(body.toString('utf-8'));
    const name = String(requestedName || '').replace(/\.sqlite3$/i, '');

    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) {
      sendError(response, 400, new Error('Invalid database name.'));
      return;
    }

    const target = join(dataPath, `${name}.sqlite3`);
    const sourcePath = join(dataPath, source);
    if (target === sourcePath) {
      sendError(response, 400, new Error('The clone must have a different name.'));
      return;
    }

    if (cloneLocks.has(target)) {
      sendError(response, 503, new Error('A clone is already running for this database.'));
      return;
    }

    const exists = existsSync(target);
    if (exists && overwrite !== true) {
      sendJson(response, 409, { exists: true, name, requiresOverwrite: true });
      return;
    }

    cloneLocks.add(target);
    try {
      const targetDatabase = databases.get(target);
      if (targetDatabase) {
        targetDatabase.close();
        databases.delete(target);
      }

      if (exists) {
        rmSync(target, { force: true });
        rmSync(`${target}-wal`, { force: true });
        rmSync(`${target}-shm`, { force: true });
      }

      await getDatabase(source).backup(target);
      sendJson(response, 201, { name, overwritten: exists });
    } finally {
      cloneLocks.delete(target);
    }
  } catch (error) {
    DEBUG && console.error(error);
    sendError(response, 400, error);
  }
}

async function onDelete(response: ServerResponse, database: string) {
  try {
    const source = join(dataPath, database);
    if (!existsSync(source)) return sendError(response, 404, new Error('Database does not exist.'));

    closeCachedDatabase(source);
    const archive = join(binPath, `${database}.${Date.now()}`);
    mkdirSync(archive, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${source}${suffix}`;
      if (existsSync(file)) renameSync(file, join(archive, `${database}${suffix}`));
    }

    sendJson(response, 200, { success: true, name: database });
  } catch (error) {
    DEBUG && console.error(error);
    sendError(response, 400, error);
  }
}

async function onRestore(request: IncomingMessage, response: ServerResponse, database: string) {
  const body = await readBody(request);
  if (!body) return sendError(response, 413, new Error('Request body too large.'));

  try {
    const { confirm } = JSON.parse(body.toString('utf-8'));
    if (confirm !== true) return sendError(response, 400, new Error('Set confirm to true to restore a database.'));

    const target = join(dataPath, database);
    if (existsSync(target)) return sendError(response, 409, new Error('A live database already exists.'));

    const archive = latestArchive(database);
    if (!archive) return sendError(response, 404, new Error('No database archive exists.'));

    for (const suffix of ['', '-wal', '-shm']) {
      const file = join(archive, `${database}${suffix}`);
      if (existsSync(file)) renameSync(file, `${target}${suffix}`);
    }
    rmSync(archive, { recursive: true, force: true });
    sendJson(response, 200, { success: true, name: database });
  } catch (error) {
    DEBUG && console.error(error);
    sendError(response, 400, error);
  }
}

async function onCleanup(request: IncomingMessage, response: ServerResponse) {
  const body = await readBody(request);
  if (!body) return sendError(response, 413, new Error('Request body too large.'));

  try {
    const { confirm } = JSON.parse(body.toString('utf-8'));
    if (confirm !== true) return sendError(response, 400, new Error('Set confirm to true to run cleanup.'));
    sendJson(response, 200, { success: true, deleted: cleanupDeletedDatabases() });
  } catch (error) {
    DEBUG && console.error(error);
    sendError(response, 400, error);
  }
}

function closeCachedDatabase(file: string) {
  const database = databases.get(file);
  if (database) {
    database.close();
    databases.delete(file);
  }
}

function latestArchive(database: string) {
  return readdirSync(binPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${database}.`))
    .map((entry) => join(binPath, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function cleanupDeletedDatabases() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];

  for (const entry of readdirSync(binPath, { withFileTypes: true })) {
    const archive = join(binPath, entry.name);
    if (entry.isDirectory() && statSync(archive).mtimeMs < cutoff) {
      rmSync(archive, { recursive: true, force: true });
      deleted.push(entry.name);
    }
  }

  return deleted;
}

async function onSchema(
  response: ServerResponse,
  db: string,
  includeInternal: boolean,
) {
  try {
    const sqlite = getDatabase(db);
    const schema = getSchema(sqlite, includeInternal);
    sendJson(response, 200, schema);
  } catch (error) {
    DEBUG && console.error(error);
    sendError(response, 400, error);
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
  let isTransaction = false;

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
      isTransaction = true;
      if (!Array.isArray(t) || !t.length) throw new Error('Invalid transaction.');

      const sqlite = getDatabase(db);
      applyPragmas(sqlite, p);
      sqlite.transaction(() => t.map((statement) => executeStatement(sqlite, statement)))();
      sendJson(response, 200, { success: true });
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
    const result = executeStatement(sqlite, { s, d, m });

    sendJson(response, 200, result ?? null);
  } catch (error) {
    DEBUG && console.error(error);
    const status = (error as { code?: string }).code === 'SQLITE_BUSY' ? 503 : 400;
    sendError(response, status, error, isTransaction ? 'Transaction failed: ' : '');
  }
}

function redactDataPath(value: string) {
  return value.replaceAll(dataPath, '***');
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(redactDataPath(JSON.stringify(value)));
}

function sendError(response: ServerResponse, status: number, error: unknown, prefix = '') {
  response.writeHead(status).end(redactDataPath(prefix + String(error)));
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

  if (method === 'exec') {
    sqlite.exec(sql.trim());
    return null;
  }

  const runner = sqlite.prepare(sql.trim());
  const execute = (runner as unknown as Record<string, (data?: unknown) => unknown>)[method];
  return statement.d === undefined ? execute.call(runner) : execute.call(runner, statement.d);
}

async function onEsModule(request: IncomingMessage, response: ServerResponse, databasePrefix: string) {
  const hostname = String(request.headers['x-forwarded-host']);
  const code = await readFile('./client.mjs', 'utf8');
  const apiBase = hostname + databasePrefix.replace(/\/$/, '');

  response
    .writeHead(200, {
      'Content-Type': 'text/javascript',
      'Access-Control-Allow-Origin': '*',
    })
    .end(redactDataPath(code.replace('__API_URL__', apiBase)));
}
