// Необязательно. Свой прокси для «Отбора» на Cloudflare Workers (бесплатный тариф).
// 1. dash.cloudflare.com → Workers & Pages → Create → Worker → вставить этот код → Deploy.
// 2. Скопировать адрес вида https://otbor-proxy.<ваше-имя>.workers.dev
// 3. В «Отборе»: Настройки → Ещё → Свой прокси → https://otbor-proxy.<ваше-имя>.workers.dev/?url=

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }
    const target = new URL(request.url).searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response('Нужен параметр ?url=', { status: 400, headers: cors() });
    }
    const upstream = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
        'Accept-Language': 'ru,en;q=0.8'
      },
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    const headers = new Headers(cors());
    const ct = upstream.headers.get('content-type');
    if (ct) headers.set('content-type', ct);
    headers.set('cache-control', 'public, max-age=300');
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  };
}
