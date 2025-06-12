import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import SQLite, { Database } from "better-sqlite3";
import { join } from "node:path";

const methods = ["all", "run", "get"];
const baseDomain = process.env.BASE_DOMAIN;
const dataPath = process.env.DATA_PATH || join(import.meta.dirname, "data");

type Q = {
  db: Database;
  request: IncomingMessage;
  response: ServerResponse;
  args: Record<string, string>;
};

export function getDatabase(file: string = "db.sqlite3"): Database {
  const fullPath = join(dataPath, file);
  const db = new SQLite(fullPath);
  db.pragma("journal_mode = WAL");
  return db;
}

export function serve() {
  const db = getDatabase();
  const server = createServer((req, res) => {
    if (baseDomain) {
      const hostname = String(req.headers["x-forwarded-for"] || "");
      const subdomain = hostname.replace(baseDomain, "").replace(".", "");

      if (subdomain) {
        return handleRequest(req, res, getDatabase(subdomain + ".sqlite3"));
      }
    }

    handleRequest(req, res, db);
  });

  server.listen(process.env.PORT);

  return server;
}

export function handleRequest(request, response, db) {
  const url = new URL(request.url, "http://localhost");
  const route = `${request.method} ${url.pathname}`.trim();
  const args = Object.fromEntries(url.searchParams.entries()) as Q["args"];
  const q: Q = { db, request, response, args };

  switch (route) {
    case "GET /index.mjs":
      return onEsModule(q);

    case "POST /query":
      return onQuery(q);

    default:
      response.writeHead(404).end();
  }
}

export async function onQuery({ db, request, response }: Q) {
  const query = Buffer.concat(await request.toArray());

  if (!query.length) {
    response.writeHead(400).end();
    return;
  }

  try {
    const { s = "", d, m = "run" } = JSON.parse(query.toString("utf-8"));
    if (!s.trim()) {
      throw new Error("Invalid statement.");
    }

    if (!methods.includes(m)) {
      throw new Error("Invalid method. Must be one of " + methods.join(", "));
    }

    const runner = db.prepare(s);
    const result = d ? runner[m](d) : runner[m]();
    response.end(JSON.stringify(result));
  } catch (error) {
    process.env.DEBUG && console.error(error);
    response.writeHead(400).end(String(error));
  }
}

let file;
async function getFile() {
  if (!file) {
    file = await readFile("./client.mjs", "utf8");
  }

  return file;
}

async function onEsModule({ request, response }: Q) {
  const hostname = request.headers["x-forwarded-for"];
  const code = await getFile();

  response
    .writeHead(200, {
      "Content-Type": "text/javascript",
      "Access-Control-Allow-Origin": "*",
    })
    .end(code.replace("__API_URL__", hostname));
}
