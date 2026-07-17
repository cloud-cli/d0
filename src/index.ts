import { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import SQLite, { Database } from "better-sqlite3";
import { join } from "node:path";
import createServer from "@cloud-cli/http";

const methods = ["all", "run", "get"];
const baseDomain = process.env.BASE_DOMAIN;
const dataPath = process.env.DATA_PATH || join(import.meta.dirname, "data");

type Query = {
  db: string;
  request: IncomingMessage;
  response: ServerResponse;
  args: Record<string, string>;
};

export function getDatabase(file: string): Database {
  const fullPath = join(dataPath, file);
  const db = new SQLite(fullPath);
  db.pragma("journal_mode = WAL");

  return db;
}

export function serve() {
  if (baseDomain) {
    return createServer((req, res) => {
      const hostname = String(req.headers["x-forwarded-host"] || "");
      const subdomain = hostname.replace(baseDomain, "").replace(".", "");

      if (subdomain) {
        return handleRequest(req, res, subdomain + ".sqlite3");
      }

      res.writeHead(400).end();
    });
  }

  return createServer((req, res) => handleRequest(req, res, "db.sqlite3"));
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  db: string,
) {
  const url = new URL(request.url, "http://localhost");
  const route = `${request.method} ${url.pathname}`.trim();
  const args = Object.fromEntries(url.searchParams.entries()) as Query["args"];
  const q: Query = { db, request, response, args };

  switch (route) {
    case "GET /console.html":
      const indexPage = await readFile("./index.html", "utf8");
      response.writeHead(200, { "content-type": "text/html" }).end(indexPage);
      return;

    case "GET /index.mjs":
      return onEsModule(q);

    case "POST /query":
      return onQuery(q);

    default:
      response.writeHead(404).end();
  }
}

export async function onQuery({ db, request, response }: Query) {
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

    const sqlite = getDatabase(db);
    const runner = sqlite.prepare(s.trim());
    const result = d ? runner[m](d) : runner[m]();
    response.end(JSON.stringify(result || null));
  } catch (error) {
    process.env.DEBUG && console.error(error);
    response.writeHead(400).end(String(error));
  }
}

let file: string;
async function getFile() {
  if (!file) {
    file = await readFile("./client.mjs", "utf8");
  }

  return file;
}

async function onEsModule({ request, response }: Query) {
  const hostname = String(request.headers["x-forwarded-for"]);
  const code = await getFile();

  response
    .writeHead(200, {
      "Content-Type": "text/javascript",
      "Access-Control-Allow-Origin": "*",
    })
    .end(code.replace("__API_URL__", hostname));
}
