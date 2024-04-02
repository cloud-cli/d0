const baseURL = 'https://__API_URL__';

export default {
  async query(statement, data) {
    const req = await fetch(new URL('/query', baseURL), {
      body: JSON.stringify({
        s: statement,
        d: data || null,
      }),
    });

    if (req.ok) {
      return await req.json();
    }

    throw new Error(await req.text());
  },
};
