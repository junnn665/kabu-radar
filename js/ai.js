// Claude による「なぜ今？」3行解説。ブラウザ（ユーザーのAPIキー）と GitHub Actions の両方から使う。

export const AI_MODELS = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（速い・安い）' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（より丁寧）' },
];
export const AI_MODEL_DEFAULT = AI_MODELS[0].id;

export const SYSTEM = `あなたは株式のテクニカル分析を個人投資家にわかりやすく説明するアシスタントです。
与えられたシグナル・ニュース見出し・決算/権利落ち日だけを根拠に、日本語でちょうど3行で答えてください。
1行目は「なぜ今？：」、2行目は「根拠：」、3行目は「リスク：」で始め、各行60字以内。
与えられていない事実（業績の数字、ニュースの中身など）を推測で書かないこと。
「買うべき」「売るべき」などの断定的な推奨はせず、判断材料の整理に徹すること。`;

export function buildPrompt(ctx) {
  const lines = [
    `銘柄: ${ctx.name} (${ctx.sym})`,
    `現在値: ${ctx.price ?? '不明'}  前日比: ${ctx.changePct != null ? ctx.changePct.toFixed(2) + '%' : '不明'}`,
    `総合スコア: ${ctx.score}（${ctx.verdict}）`,
    'シグナル:',
    ...(ctx.signals?.length ? ctx.signals.map((s) => `- ${s.label}（${s.weight > 0 ? '+' : ''}${s.weight}点）: ${s.detail}`) : ['- なし']),
  ];
  if (ctx.stats?.length) {
    lines.push('過去成績（シグナル点灯後5営業日のリターン、全対象銘柄）:');
    ctx.stats.forEach((s) => lines.push(`- ${s.label}: 勝率${(s.win * 100).toFixed(0)}% 平均${(s.avg * 100).toFixed(2)}% (n=${s.n})`));
  }
  const ev = ctx.events || {};
  lines.push(`次の決算日: ${ev.earnings || '不明'} / 次の権利落ち日: ${ev.exDiv || '不明'}${ev.exDivEstimated ? '（推定）' : ''}`);
  lines.push('最近のニュース見出し:');
  lines.push(...(ctx.news?.length ? ctx.news.slice(0, 5).map((n) => `- ${n.title}${n.publisher ? `（${n.publisher}）` : ''}`) : ['- なし']));
  return lines.join('\n');
}

export async function explain({ apiKey, model = AI_MODEL_DEFAULT, ctx, browser = false }) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  if (browser) headers['anthropic-dangerous-direct-browser-access'] = 'true';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(ctx) }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
}

// GitHub Models（GitHub Actions の GITHUB_TOKEN で使える無料枠。キー登録・課金不要）
// エンドポイントが変わることがあるため、既知の2つを順に試す
export const GH_MODEL_DEFAULT = 'openai/gpt-4.1-mini';
const GH_ENDPOINTS = [
  { url: 'https://models.github.ai/inference/chat/completions', model: (m) => m },
  { url: 'https://models.inference.ai.azure.com/chat/completions', model: (m) => m.replace(/^[^/]+\//, '') },
];
export async function explainGithub({ token, model = GH_MODEL_DEFAULT, ctx }) {
  const errors = [];
  for (const ep of GH_ENDPOINTS) {
    try {
      const init = {
        method: 'POST',
        redirect: 'manual', // リダイレクトで GET に化けないよう、POST のまま自分で追いかける
        headers: {
          'content-type': 'application/json', accept: 'application/json',
          authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({
          model: ep.model(model),
          max_tokens: 400,
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildPrompt(ctx) }],
        }),
      };
      let url = ep.url, r, hops = [];
      for (let i = 0; i < 4; i++) {
        r = await fetch(url, init);
        if (r.status < 300 || r.status >= 400 || !r.headers.get('location')) break;
        url = new URL(r.headers.get('location'), url).toString();
        hops.push(`${r.status}→${url}`);
      }
      if (hops.length) errors.push(`redirects: ${hops.join(', ')}`);
      const raw = await r.text();
      let j = {};
      try { j = JSON.parse(raw); } catch {}
      const text = (j.choices?.[0]?.message?.content || '').trim();
      if (r.ok && text) return text;
      errors.push(`${new URL(ep.url).host} HTTP ${r.status}: ${(j?.error?.message || raw).slice(0, 150)}`);
    } catch (e) {
      errors.push(`${new URL(ep.url).host}: ${e.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

// Claude アプリで聞くための質問文（コピー＆貼り付け用）
export function chatPrompt(ctx) {
  return `${SYSTEM}\n\n${buildPrompt(ctx)}`;
}
