const baseURL = "https://__API_URL__";

export async function query(statement, data, method = "run") {
  const req = await fetch(new URL("/query", baseURL), {
    method: "POST",
    body: JSON.stringify({
      s: statement,
      d: data || null,
      m: method,
    }),
  });

  if (req.ok) {
    return await req.json();
  }

  throw new Error(await req.text());
}

export function get(statement, data) {
  return query(statement, data, "get");
}

export function run(statement, data) {
  return query(statement, data, "run");
}

export function all(statement, data) {
  return query(statement, data, "all");
}

export default { query, get, run, all };
