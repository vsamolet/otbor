// Таймер для «Отбора» на Cloudflare Workers (бесплатный тариф).
// GitHub запускает задания по расписанию с опозданием на часы, поэтому сборку запускает этот воркер:
// раз в 15 минут он просит GitHub запустить workflow «Сборка ленты».
//
// Что нужно в настройках воркера (Settings → Variables and Secrets):
//   GITHUB_TOKEN — секрет (тип Secret): fine-grained ключ GitHub с доступом только к репозиторию otbor,
//                  право «Actions: Read and write».
// Расписание (Settings → Triggers → Cron Triggers): */15 * * * *
//
// Открыть адрес воркера в браузере — увидите, когда он последний раз запускал сборку и чем это кончилось.

const REPO = 'vsamolet/otbor';
const WORKFLOW = 'feed.yml';

async function dispatch(env) {
  if (!env.GITHUB_TOKEN) return { ok: false, status: 0, text: 'не задан секрет GITHUB_TOKEN' };
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'otbor-timer',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ref: 'main' })
  });
  return { ok: r.status === 204, status: r.status, text: r.status === 204 ? 'сборка запущена' : await r.text() };
}

async function lastRuns() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=6`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'otbor-timer' }
    });
    const j = await r.json();
    return (j.workflow_runs || []).map(x =>
      `${x.created_at.replace('T', ' ').slice(0, 16)} UTC  ${x.event.padEnd(17)} ${x.conclusion || x.status}`).join('\n');
  } catch (e) { return 'не удалось получить список: ' + e.message; }
}

export default {
  async scheduled(event, env, ctx) {
    const res = await dispatch(env);
    if (!res.ok) console.log('Ошибка запуска сборки:', res.status, res.text);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    let head = 'Таймер «Отбора» работает. Сборка запускается по расписанию воркера.';
    // ручная проверка ключа: адрес-воркера/?test
    if (url.searchParams.has('test')) {
      const res = await dispatch(env);
      head = res.ok ? 'Проверка: ключ работает, сборка запущена.' : `Проверка не прошла: ${res.status} ${res.text}`;
    }
    const body = `${head}\n\nПоследние сборки:\n${await lastRuns()}\n`;
    return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
};
