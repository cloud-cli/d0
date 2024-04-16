const baseURL = 'https://__API_URL__';

export default {
  async query(statement, data, method = 'run') {
    const req = await fetch(new URL('/query', baseURL), {
      method: 'POST',
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
  },
};
