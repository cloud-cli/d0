const baseURL = "https://__API_URL__";

let pragmas = [];

async function query(method, statement, data, pragma = pragmas, transaction) {
  const req = await fetch(new URL("/query", baseURL), {
    method: "POST",
    body: JSON.stringify({
      s: statement,
      d: data,
      m: method,
      p: pragma,
      t: transaction
    }),
  });

  if (req.ok) {
    return await req.json();
  }

  throw new Error(await req.text());
}

export async function schema({ internal = false } = {}) {
  const url = new URL('/schema', baseURL);
  if (internal) url.searchParams.set('internal', '1');

  const req = await fetch(url);
  if (req.ok) return req.json();
  throw new Error(await req.text());
}

export async function transaction(statements, pragma = pragmas) {
  return query('transaction', undefined, undefined, pragma, statements);
}

export const get = query.bind(null, 'get');
export const run = query.bind(null, 'run');
export const all = query.bind(null, 'all');
export const exec = query.bind(null, 'exec');

export function pragma(p) {
  if (Array.isArray(p) && p.every(s => typeof s === 'string')) {
    pragmas = p;
  }
}

export default { query, get, run, all, exec, transaction, schema, pragma };
