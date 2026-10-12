// AIを使わない「なぜ今？」3行まとめ。シグナル・過去成績・決算日から機械的に組み立てる（無料・キー不要）。

const md = (d) => (d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '');
const pct = (v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;

export function ruleExplain({ score, verdict, signals = [], stats = {}, events, today }) {
  const pos = signals.filter((s) => s.weight > 0);
  const neg = signals.filter((s) => s.weight < 0);

  // 1行目：なぜ今？
  let why;
  if (pos.length >= 2) why = `${pos[0].label}と${pos[1].label}が同時に点灯し、スコア${score}（${verdict}）。`;
  else if (pos.length === 1) why = `${pos[0].label}が点灯し、スコア${score}（${verdict}）。`;
  else if (neg.length) why = `買いのシグナルはなく、${neg[0].label}が出ていてスコア${score}（${verdict}）。`;
  else why = `目立ったシグナルはなく、スコア${score}（${verdict}）。`;

  // 2行目：根拠（点灯中シグナルの過去成績のうち、回数が十分なもの）
  const withStats = signals
    .map((s) => ({ ...s, st: stats[s.id] }))
    .filter((s) => s.st?.n >= 30)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  let basis;
  if (withStats.length) {
    const s = withStats[0];
    const good = s.st.win >= 0.53 && s.st.avg > 0;
    const weak = s.st.win < 0.5 || (s.weight > 0 && s.st.avg <= 0);
    basis = `過去1年、${s.label}の後5日間は勝率${Math.round(s.st.win * 100)}%・平均${pct(s.st.avg)}（${s.st.n}回）`
      + (good ? 'と、比較的よく効いている。' : weak ? 'で、当たりやすいとは言えない。' : 'で、効き目は五分五分。');
  } else {
    basis = signals.length ? '点灯中のシグナルは過去の発生回数が少なく、成績からの裏付けはまだ弱い。' : '判断材料になるシグナルが出ていない。';
  }

  // 3行目：リスク
  const risks = [];
  const days = (d) => (d && today ? Math.round((Date.parse(d) - Date.parse(today)) / 86400e3) : null);
  const de = days(events?.earnings), dx = days(events?.exDiv);
  if (de != null && de >= 0 && de <= 14) risks.push(`${md(events.earnings)}に決算発表があり、前後で大きく動く可能性`);
  if (dx != null && dx >= 0 && dx <= 14) risks.push(`${md(events.exDiv)}が権利落ち日${events.exDivEstimated ? '（推定）' : ''}で、配当分ほど値下がりしやすい`);
  if (neg.length && pos.length) risks.push(`${neg[0].label}も同時に出ている`);
  if (!risks.length) risks.push('テクニカル指標だけの判断で、業績や地合いの急変は織り込めていない');
  const risk = `${risks.slice(0, 2).join('。また、')}。`;

  return `なぜ今？：${why}\n根拠：${basis}\nリスク：${risk}`;
}
