/* お茶コーチ · おもちゃの知覚モデル + 制約付きコーチ + お茶探し（DOM に依存しない）
 * 係数はすべて作り話。方向だけ常識に合わせている：
 *   カテキン（渋み・苦み）は湯温に敏感で、ゆっくり溶け出す；
 *   アミノ酸（旨み・甘み）は低温でも早く溶け出す；
 *   カフェインはその中間；
 *   焙煎・発酵した茶（岩茶・紅茶・普洱）は渋みのもとが少なく、熱湯向き。
 * 実際のシステムでは predict() を Phase 1 の官能評価データで当てはめたモデルに置き換える。
 *
 * 大事な仮定：知覚（どれくらい渋いか、どれくらい香るか）は人によってあまり変わらない。
 * 好みは「その人がそれぞれの知覚をどう評価するか」で、8＋1 個の口味パラメータ prof で表す。
 * だから 1 種類のお茶で推定した prof を、別のお茶の予測に使える。 */
(function (g) {
  'use strict';
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  const VARS = {
    T: { name: '湯温', unit: '°C', step: 10, min: 60, max: 100, dec: 0, up: '上げる', down: '下げる' },
    t: { name: '時間', unit: '秒', step: 30, min: 30, max: 300, dec: 0, up: '延ばす', down: '縮める' },
    r: { name: '茶葉', unit: 'g/100ml', step: 0.5, min: 0.5, max: 3, dec: 1, up: '増やす', down: '減らす' }
  };
  const DIMS = [['ast', '渋み'], ['bit', '苦み'], ['umami', '旨み'], ['sweet', '回甘'], ['body', '濃さ'], ['aroma', '香り'], ['roast', '焙煎香'], ['grass', '青み'], ['earthy', '熟成香']];
  const DIM_NAME = Object.fromEntries(DIMS.concat([['like', '好み']]));

  // ---------------------------------------------------------- 中国茶 7 種（係数は作り話）
  // c/f/a：カテキン・カフェイン・アミノ酸の量の倍率；peak：香りがいちばん立つ湯温；gain：香りの強さ
  // rinse：洗茶（最初に湯を短く通して捨てる）をするかどうか
  const TEAS = {
    longjing:   { name: '西湖龍井', cat: '緑茶', Tr: [70, 90], c: 0.85, f: 0.9, a: 0.95, peak: 80, gain: 1.1, roast: 1.2, grass: 4.5, earthy: 0, sweetB: 0.3, bodyB: 0, rinse: false,
                  note: '釜炒りの緑茶。栗のような香ばしさと旨み。熱湯だとすぐ渋くなる', leaf: 0x6f8a3a, can: 0x5f8f3a,
                  stops: [[0.9, 0.93, 0.88], [0.88, 0.9, 0.62], [0.8, 0.78, 0.36], [0.62, 0.58, 0.18]] },
    jasmine:    { name: '茉莉花茶', cat: '花茶', Tr: [75, 95], c: 0.6, f: 0.9, a: 0.6, peak: 85, gain: 2.0, roast: 0, grass: 2, earthy: 0, sweetB: 0.6, bodyB: 0, rinse: false,
                  note: '緑茶にジャスミンの花の香りを移したもの。香りがとても強い', leaf: 0x5a6f35, can: 0xe8d9a8,
                  stops: [[0.92, 0.93, 0.86], [0.9, 0.88, 0.6], [0.84, 0.75, 0.35], [0.7, 0.58, 0.2]] },
    baimudan:   { name: '白牡丹', cat: '白茶', Tr: [75, 95], c: 0.45, f: 0.8, a: 0.5, peak: 90, gain: 1.0, roast: 0, grass: 3, earthy: 0, sweetB: 2.1, bodyB: 0.5, rinse: false,
                  note: '白茶。ほとんど手を加えずに干したお茶で、干し草と蜜のような甘み', leaf: 0x9a9a72, can: 0xd9d4c4,
                  stops: [[0.94, 0.93, 0.86], [0.92, 0.86, 0.62], [0.86, 0.72, 0.4], [0.74, 0.55, 0.24]] },
    tieguanyin: { name: '鉄観音', cat: '烏龍茶（軽発酵）', Tr: [85, 100], c: 0.45, f: 0.9, a: 0.5, peak: 95, gain: 2.0, roast: 1, grass: 1, earthy: 0, sweetB: 1.2, bodyB: 0.4, rinse: true,
                  note: '丸まった粒状の烏龍茶。蘭のような花の香りと、飲んだ後の回甘', leaf: 0x4a6a2a, can: 0x3f7f6a,
                  stops: [[0.93, 0.92, 0.8], [0.9, 0.84, 0.5], [0.82, 0.66, 0.24], [0.66, 0.46, 0.12]] },
    dahongpao:  { name: '大紅袍', cat: '烏龍茶（岩茶）', Tr: [90, 100], c: 0.55, f: 0.9, a: 0.3, peak: 98, gain: 1.5, roast: 6, grass: 0, earthy: 0, sweetB: 1.8, bodyB: 1.0, rinse: true,
                  note: '武夷山の岩茶。しっかり焙煎していて、香ばしく厚みがある', leaf: 0x4a3020, can: 0x9a3a2a,
                  stops: [[0.92, 0.86, 0.72], [0.84, 0.62, 0.32], [0.66, 0.38, 0.14], [0.46, 0.22, 0.08]] },
    dianhong:   { name: '滇紅', cat: '紅茶', Tr: [85, 100], c: 0.6, f: 1.0, a: 0.3, peak: 95, gain: 1.6, roast: 0.5, grass: 0, earthy: 0, sweetB: 2.5, bodyB: 1.5, rinse: false,
                  note: '雲南の紅茶。金色の芽が多く、蜜のような甘い香りでまろやか', leaf: 0x5a3418, can: 0xc77a2a,
                  stops: [[0.94, 0.86, 0.8], [0.88, 0.55, 0.3], [0.68, 0.28, 0.12], [0.46, 0.14, 0.06]] },
    shupuer:    { name: '熟普洱', cat: '黒茶', Tr: [90, 100], c: 0.25, f: 0.8, a: 0.2, peak: 98, gain: 1.2, roast: 1, grass: 0, earthy: 7, sweetB: 2.2, bodyB: 2.5, rinse: true,
                  note: '微生物で発酵させた黒茶。土や木のような熟成香、とろりとして渋みはほとんどない', leaf: 0x2a1a10, can: 0x4a3328,
                  stops: [[0.86, 0.76, 0.66], [0.62, 0.36, 0.2], [0.4, 0.18, 0.08], [0.24, 0.1, 0.05]] }
  };
  const TEA_IDS = Object.keys(TEAS);
  const teaOf = id => TEAS[id] || TEAS.longjing;

  // ---------------------------------------------------------- 口味パラメータ
  // PRIOR = 一般的な初心者；SCALE = 各パラメータの「1 単位のずれ」の大きさ
  const PRIOR = { astTol: 3, bitTol: 3, bodyPref: 4.5, sweetW: 0.3, umamiW: 0.1, aromaW: 0.15, roastW: 0, grassW: 0, earthyW: 0 };
  const SCALE = { astTol: 1.5, bitTol: 1.5, bodyPref: 1.5, sweetW: 0.2, umamiW: 0.2, aromaW: 0.2, roastW: 0.15, grassW: 0.15, earthyW: 0.15 };
  const PKEYS = Object.keys(PRIOR);
  const P = o => Object.assign({}, PRIOR, o);
  const PERSONAS = [
    { id: 'novice', name: '一般的な初心者', desc: 'モデルの初期仮定と同じ', prof: P({}) },
    { id: 'shy', name: '渋みが苦手・香り重視', desc: '少しでも渋いと受けつけず、香りを大事にする', prof: P({ astTol: 1.8, bitTol: 2.5, aromaW: 0.45 }) },
    { id: 'rich', name: '旨み・コク好き', desc: '渋みは平気。濃くて旨みのあるのが好きで、焦げや熟成の匂いは苦手', prof: P({ umamiW: 0.35, bodyPref: 6.5, astTol: 4.5, bitTol: 4, roastW: -0.12, earthyW: -0.12, grassW: 0.08 }) },
    { id: 'sweet', name: '甘党', desc: 'いちばん大事なのは回甘。苦いのが苦手', prof: P({ sweetW: 0.55, bitTol: 2, astTol: 2.5, umamiW: 0 }) },
    { id: 'nograss', name: '青みが苦手', desc: '緑茶の青っぽさが「草を飲んでいる」ように感じる', prof: P({ grassW: -0.25, aromaW: 0.2, roastW: 0.05 }) },
    { id: 'deep', name: '焙煎香・熟成香が好き', desc: '香ばしくて濃いお茶が好き。コーヒー好きに多いタイプ', prof: P({ roastW: 0.3, earthyW: 0.3, bodyPref: 6, astTol: 3.5, umamiW: 0 }) }
  ];

  function extraction(p) {
    const kc = 0.0016 * Math.exp(0.07 * (p.T - 80));   // カテキン：湯温にいちばん敏感
    const kf = 0.003 * Math.exp(0.045 * (p.T - 80));   // カフェイン
    const ka = 0.02 * Math.exp(0.015 * (p.T - 80));    // アミノ酸
    return { Ec: 1 - Math.exp(-kc * p.t), Ef: 1 - Math.exp(-kf * p.t), Ea: 1 - Math.exp(-ka * p.t) };
  }

  /** 知覚 → 好み（1–7） */
  function likeFrom(pr, prof) {
    const q = prof || PRIOR;
    const z = q.sweetW * (pr.sweet - 3) + q.umamiW * (pr.umami - 4) + q.aromaW * (pr.aroma - 4)
      + q.roastW * (pr.roast - 3) + q.grassW * (pr.grass - 3) + q.earthyW * (pr.earthy - 3)
      - 0.55 * Math.max(0, pr.ast - q.astTol) - 0.5 * Math.max(0, pr.bit - q.bitTol) - 0.35 * Math.abs(pr.body - q.bodyPref);
    return 1 + 6 / (1 + Math.exp(-(z + 0.4)));
  }

  /** パラメータ → 知覚（0–10）、好み（1–7）、カフェイン（mg / 100 ml、桁の目安） */
  function predict(p, teaId, prof) {
    const T = teaOf(teaId);
    const { Ec, Ef, Ea } = extraction(p);
    const s = p.r / 1.5;
    const sat = x => 10 * (1 - Math.exp(-x));
    const steep = 1 - Math.exp(-p.t / 60);
    const hot = (p.T - 60) / 40;
    const rk = T.rinse ? 0.92 : 1;   // 洗茶で最初の少しが捨てられる
    const ast = sat(1.2 * s * Ec * T.c * rk);
    const bit = sat(0.6 * s * Ef * T.f * rk);
    const umami = sat(0.65 * s * Ea * T.a * rk);
    const sweet = clamp(0.7 * umami + 0.1 * ast - 0.3 * Math.max(0, bit - 3) + 1.3 * T.sweetB * Math.min(1.5, s) * steep, 0, 10);
    const body = sat(s * (0.4 * Ec * T.c + 0.3 * Ea * T.a + 0.2 * Ef * T.f) + 0.25 * s * T.bodyB * steep);
    const aroma = sat(0.55 * Math.min(1.6, s) * T.gain * (0.2 + 0.8 * Math.exp(-Math.pow((p.T - T.peak) / 12, 2))) * steep);
    const roast = clamp(T.roast * Math.min(1.4, s) * steep * (0.75 + 0.25 * hot), 0, 10);
    const grass = clamp(T.grass * Math.min(1.4, s) * steep * (0.6 + 0.4 * hot), 0, 10);
    const earthy = clamp(T.earthy * Math.min(1.4, s) * steep * (T.rinse ? 0.8 : 1), 0, 10);
    const pr = { ast, bit, umami, sweet, body, aroma, roast, grass, earthy };
    pr.like = likeFrom(pr, prof);
    pr.caffeine = p.r * 28 * Ef * T.f;
    return pr;
  }

  /** 茶液の色 */
  function teaColor(p, k, teaId) {
    const st = teaOf(teaId).stops;
    const s = p.r / 1.5;
    const d = clamp(0.72 * s * (1 - Math.exp(-p.t / 120)) * (0.7 + 0.3 * (p.T - 60) / 40), 0, 1) * (k == null ? 1 : k);
    const x = clamp(d, 0, 1) * (st.length - 1), i = Math.min(st.length - 2, Math.floor(x)), f = x - i;
    return st[i].map((c, j) => c + (st[i + 1][j] - c) * f);
  }

  // ---------------------------------------------------------- ことばを理解する（本番では LLM がやる）
  // 日本語と中国語の両方のキーワード。順番が大事（「焦げ」を「香り」より先に見る など）
  const INTENTS = [
    { re: /焦|焙煎|スモーキー|煙|けむ|烤|焙|糊/, dim: 'roast', dir: -1, label: '焙煎香が強すぎる' },
    { re: /土|カビ|かび|ほこり|埃|古い|熟成|蔵|霉|陈|泥/, dim: 'earthy', dir: -1, label: '熟成香が強すぎる' },
    { re: /草|青臭|青み|青っぽ|海苔|野菜|生臭|腥|菜/, dim: 'grass', dir: -1, label: '青みが強すぎる' },
    { re: /渋|しぶ|涩|きしむ|ギシギシ|口が乾|収れん|刮|发干/, dim: 'ast', dir: -1, label: '渋い' },
    { re: /苦|にが/, dim: 'bit', dir: -1, label: '苦い' },
    { re: /薄|うす|水っぽ|味がしない|物足りな|もっと濃|淡|像水|没味|寡/, dim: 'body', dir: 1, label: '薄い' },
    { re: /濃|こい|重|きつ|浓|齁|冲/, dim: 'body', dir: -1, label: '濃すぎる' },
    { re: /甘|あま|甜/, dim: 'sweet', dir: 1, label: '甘みが足りない' },
    { re: /旨|うま味|だし|鮮|鲜/, dim: 'umami', dir: 1, label: '旨みが足りない' },
    { re: /香|におい|匂|かおり/, dim: 'aroma', dir: 1, label: '香りが弱い' }
  ];
  function parseIntent(text) {
    const s = String(text || '').replace(/苦手/g, '');   // 「〜が苦手」を「苦い」と取り違えない
    for (const it of INTENTS) if (it.re.test(s)) return { dim: it.dim, dir: it.dir, label: it.label, vague: false };
    return { dim: 'like', dir: 1, label: 'うまく言えないが、好きではない', vague: true };
  }

  // うまく言えないときは、「この人」の口味パラメータでいちばん減点が大きい項目を探す
  const DIAG = {
    '渋み': { dim: 'ast', dir: -1, label: '渋い', say: '渋い' },
    '苦み': { dim: 'bit', dir: -1, label: '苦い', say: '苦い' },
    '薄さ': { dim: 'body', dir: 1, label: '薄い', say: '薄い' },
    '濃さ': { dim: 'body', dir: -1, label: '濃すぎる', say: '濃すぎる' },
    '焙煎香': { dim: 'roast', dir: -1, label: '焙煎香が強すぎる', say: '焦げっぽい' },
    '青み': { dim: 'grass', dir: -1, label: '青みが強すぎる', say: '草みたいな味がする' },
    '熟成香': { dim: 'earthy', dir: -1, label: '熟成香が強すぎる', say: '土っぽい' }
  };
  const VAGUE_SAY = 'うまく言えないけど、好きじゃない';
  function diagnose(pr, prof) {
    const q = prof || PRIOR;
    const c = [
      ['渋み', 0.55 * Math.max(0, pr.ast - q.astTol)],
      ['苦み', 0.5 * Math.max(0, pr.bit - q.bitTol)],
      ['薄さ', 0.35 * Math.max(0, q.bodyPref - pr.body)],
      ['濃さ', 0.35 * Math.max(0, pr.body - q.bodyPref)],
      ['焙煎香', Math.max(0, -q.roastW) * Math.max(0, pr.roast - 3)],
      ['青み', Math.max(0, -q.grassW) * Math.max(0, pr.grass - 3)],
      ['熟成香', Math.max(0, -q.earthyW) * Math.max(0, pr.earthy - 3)]
    ].filter(x => x[1] > 0.25).sort((a, b) => b[1] - a[1]);
    return c.length ? c[0][0] : '';
  }
  /** デモ用：模擬の舌がどう言うか */
  function complain(pr, prof) {
    const dg = diagnose(pr, prof);
    return dg ? DIAG[dg].say : VAGUE_SAY;
  }

  // ---------------------------------------------------------- 候補：一度に 1 つの変数だけ動かす
  const ACTS = [['T', -1], ['T', 1], ['t', -1], ['t', 1], ['r', -1], ['r', 1]];
  const actId = a => a[0] + (a[1] < 0 ? '-' : '+');
  function actLabel(a) {
    const v = VARS[a[0]];
    return v.name + 'を ' + v.step + (a[0] === 'T' ? ' °C' : a[0] === 't' ? ' 秒' : ' g') + ' ' + (a[1] < 0 ? v.down : v.up);
  }
  function applyAct(p, a) {
    const v = VARS[a[0]], q = Object.assign({}, p);
    q[a[0]] = +clamp(p[a[0]] + a[1] * v.step, v.min, v.max).toFixed(v.dec);
    return q;
  }

  function candidates(p, intent, teaId, prof) {
    const base = predict(p, teaId, prof);
    const out = [];
    for (const a of ACTS) {
      const q = applyAct(p, a);
      const same = q[a[0]] === p[a[0]];
      const pr = predict(q, teaId, prof);
      const dT = intent.dim === 'like' ? pr.like - base.like : pr[intent.dim] - base[intent.dim];
      const dLike = pr.like - base.like;
      // 言われた問題を直しつつ、ほかを悪くしない（好みの予測変化を副作用として足す）
      let score = same ? -Infinity : (intent.dim === 'like' ? dLike : intent.dir * dT + 1.5 * dLike);
      // 言われた問題にほとんど効かない案は後ろへ
      if (!same && intent.dim !== 'like' && intent.dir * dT < 0.1) score -= 10;
      out.push({ id: actId(a), act: a, label: actLabel(a), q, pr, dT, dLike, score, disabled: same });
    }
    return out.sort((x, y) => y.score - x.score);
  }
  /** 焙煎香・青み・熟成香はそのお茶の個性：「お茶の味がする」淹れ方（濃さ ≥ 3.5）では抑えきれないなら、茶を替える提案 */
  function cantFix(teaId, intent) {
    if (!intent || intent.vague || intent.dir > 0 || ['roast', 'grass', 'earthy'].indexOf(intent.dim) < 0) return false;
    let min = Infinity;
    for (let T = 60; T <= 100; T += 10) for (let t = 30; t <= 300; t += 30) for (let r = 0.5; r <= 3.001; r += 0.5) {
      const pr = predict({ T, t, r }, teaId);
      if (pr.body >= 3.5 && pr[intent.dim] < min) min = pr[intent.dim];
    }
    return min > 3;
  }

  const WHY = {
    'T-': '湯温が低いと、渋みと苦みのもとになるカテキンが溶け出しにくくなります。旨みと甘みのもとになるアミノ酸は低温でも溶けるので、失うものは少なめです。',
    'T+': '湯温を上げると、カテキンとカフェインが早く溶け出します。香りは立ちますが、渋みと苦みも一緒に増えます。',
    't-': '渋みと苦みはゆっくり溶け出すので、長く浸すほど増えます。時間を縮めると、後半に出てくる渋みと苦みを主に減らせます。',
    't+': '長く浸すと、どの成分も少しずつ多く出ます。旨みと甘みは早いうちにほぼ出きっているので、後から増えるのは主に渋みです。',
    'r-': '茶葉を減らすと、すべての成分が一緒に減ります。渋みと苦みは下がりますが、旨みや香りも下がります。',
    'r+': '茶葉を増やすと、すべての成分が一緒に増えます。味は濃くなりますが、渋みも同じ割合で増えます。'
  };
  const f1 = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1);

  function explain(c, intent, p, teaId, prof) {
    const base = predict(p, teaId, prof);
    const parts = [];
    for (const [k, n] of DIMS) {
      const d = c.pr[k] - base[k];
      if (Math.abs(d) >= 0.3) parts.push(n + ' ' + f1(d));
    }
    parts.push('好み ' + f1(c.dLike));
    let lead = '';
    if (intent.vague) {
      const dg = diagnose(base, prof);
      lead = dg ? 'うまく言えないとのことなので、あなたの好みの推定から考えると、この一杯でいちばん問題になっていそうなのは「' + DIAG[dg].label + '」です。'
        : 'うまく言えないとのことですが、モデルにもはっきりした問題は見えないので、予測される好みがいちばん上がる案を選びました。';
    }
    return { lead, why: WHY[c.id], effect: parts.join('、') };
  }

  function judgeGuess(guessId, choiceId) {
    if (guessId === choiceId) return { ok: true, kind: 'right' };
    if (guessId[0] === choiceId[0]) return { ok: false, kind: 'direction' };
    return { ok: false, kind: 'other' };
  }

  // ---------------------------------------------------------- お茶探し：評価から口味パラメータを推定
  const hinge = x => (x > 0 ? x * x : 0);
  function complaintLoss(it, pr, th) {
    switch (it.dim) {
      // 「渋い」と言ったなら、この一杯の渋みはその人の許容度をだいぶ超えている
      case 'ast': return hinge((th.astTol - (pr.ast - 1)) / SCALE.astTol);
      case 'bit': return hinge((th.bitTol - (pr.bit - 1)) / SCALE.bitTol);
      case 'body': return it.dir > 0 ? hinge((pr.body + 1 - th.bodyPref) / SCALE.bodyPref) : hinge((th.bodyPref - (pr.body - 1)) / SCALE.bodyPref);
      case 'sweet': return hinge((PRIOR.sweetW + 0.15 - th.sweetW) / SCALE.sweetW);
      case 'umami': return hinge((PRIOR.umamiW + 0.15 - th.umamiW) / SCALE.umamiW);
      case 'aroma': return hinge((PRIOR.aromaW + 0.15 - th.aromaW) / SCALE.aromaW);
      case 'roast': return hinge((th.roastW + 0.2) / SCALE.roastW);
      case 'grass': return hinge((th.grassW + 0.2) / SCALE.grassW);
      case 'earthy': return hinge((th.earthyW + 0.2) / SCALE.earthyW);
      default: return 0;
    }
  }
  const toProf = u => Object.fromEntries(PKEYS.map((k, i) => [k, PRIOR[k] + u[i] * SCALE[k]]));
  /** cups: [{pr, rating, intent}]。評価の誤差 + 不満の制約 + 事前分布（一般的な初心者から離れるほど証拠が要る） */
  function fitProfile(cups) {
    const data = (cups || []).filter(c => c && c.pr);
    let u = PKEYS.map(() => 0);
    if (!data.length) return toProf(u);
    const loss = v => {
      const th = toProf(v);
      let L = 0;
      for (const c of data) {
        if (c.rating != null) { const e = likeFrom(c.pr, th) - c.rating; L += e * e; }
        if (c.intent && !c.intent.vague) L += 3 * complaintLoss(c.intent, c.pr, th);
      }
      for (const x of v) L += 0.35 * x * x;
      return L;
    };
    // Adam 風の勾配降下（数値勾配。パラメータ 9 個なので十分速い）
    const eps = 1e-4, lr = 0.06, m = u.map(() => 0), s2 = u.map(() => 0);
    for (let it = 1; it <= 300; it++) {
      const L0 = loss(u);
      const grad = u.map((x, i) => { const v = u.slice(); v[i] += eps; return (loss(v) - L0) / eps; });
      for (let i = 0; i < u.length; i++) {
        m[i] = 0.9 * m[i] + 0.1 * grad[i]; s2[i] = 0.999 * s2[i] + 0.001 * grad[i] * grad[i];
        const mh = m[i] / (1 - Math.pow(0.9, it)), sh = s2[i] / (1 - Math.pow(0.999, it));
        u[i] = clamp(u[i] - lr * mh / (Math.sqrt(sh) + 1e-8), -3, 3);
      }
    }
    return toProf(u);
  }

  const TRAIT = {
    astTol: ['ast', '渋みに強い', '渋みが苦手'],
    bitTol: ['bit', '苦みに強い', '苦みが苦手'],
    bodyPref: ['body', '濃いめが好き', 'あっさりが好き'],
    sweetW: ['sweet', '回甘が好き', '甘みはあまり気にしない'],
    umamiW: ['umami', '旨みが好き', '旨みはあまり気にしない'],
    aromaW: ['aroma', '香り重視', '香りはあまり気にしない'],
    roastW: ['roast', '焙煎香が好き', '焙煎香が苦手'],
    grassW: ['grass', '青い香りが好き', '青みが苦手'],
    earthyW: ['earthy', '熟成香が好き', '熟成香が苦手']
  };
  /** 「一般的な初心者」といちばん違う項目 */
  function profileTraits(prof, min) {
    const m = min == null ? 0.5 : min;
    return PKEYS.map(k => {
      const d = (prof[k] - PRIOR[k]) / SCALE[k];
      return { key: k, d, dim: TRAIT[k][0], text: d >= 0 ? TRAIT[k][1] : TRAIT[k][2] };
    }).filter(x => Math.abs(x.d) >= m).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  }

  /** あるお茶の、この人にとっていちばんよい淹れ方。そのお茶の一般的な湯温の範囲 Tr の中でグリッド探索（同点ならカフェインが少ない方） */
  function bestBrew(teaId, prof) {
    let best = null; const Tr = teaOf(teaId).Tr;
    for (let T = Tr[0]; T <= Tr[1]; T += 5) for (let t = 30; t <= 300; t += 30) for (let r = 0.5; r <= 3.001; r += 0.5) {
      const p = { T, t, r: +r.toFixed(1) };
      const pr = predict(p, teaId, prof);
      const s = pr.like - 0.001 * pr.caffeine;
      if (!best || s > best.s) best = { p, pr, like: pr.like, s };
    }
    return best;
  }

  /** 次のお茶を推薦：「あなたにいちばん合う淹れ方」同士で比べる。まだ飲んでいないお茶には少し探索点を足す */
  function recommend(prof, tried, cur) {
    const tr = tried || [];
    return TEA_IDS.map(id => {
      const bb = bestBrew(id, prof);
      const isTried = tr.indexOf(id) >= 0;
      return { id, name: TEAS[id].name, bb, like: bb.like, tried: isTried, cur: id === cur,
        score: bb.like + (isTried ? 0 : 0.25) - (id === cur ? 0.6 : 0) };
    }).sort((a, b) => b.score - a.score);
  }

  const tLabel = t => (t >= 60 ? Math.floor(t / 60) + ' 分' + (t % 60 ? ' ' + (t % 60) + ' 秒' : '') : t + ' 秒');
  function explainTea(rec, prof) {
    const T = TEAS[rec.id], pr = rec.bb.pr, p = rec.bb.p;
    const traits = profileTraits(prof).slice(0, 2);
    let s = traits.length ? 'いまのモデルの推定では、あなたは「' + traits.map(x => x.text).join('」「') + '」です。' : 'まだはっきりした好みは見えていません。';
    s += T.name + '（' + T.cat + '）：' + T.note + '。';
    s += 'あなたの好みに合わせて ' + p.T + ' °C・' + tLabel(p.t) + '・' + p.r.toFixed(1) + ' g で淹れると、';
    if (traits.length) s += '予測は' + traits.map(x => DIM_NAME[x.dim] + ' ' + pr[x.dim].toFixed(1)).join('、') + '、';
    s += '好みは約 ' + rec.like.toFixed(1) + ' 点です。';
    return s;
  }

  g.TeaModel = { clamp, VARS, DIMS, DIM_NAME, TEAS, TEA_IDS, PRIOR, SCALE, PKEYS, PERSONAS, DIAG, VAGUE_SAY,
    predict, likeFrom, teaColor, parseIntent, diagnose, complain, ACTS, actId, actLabel, applyAct,
    candidates, cantFix, explain, judgeGuess, fitProfile, profileTraits, bestBrew, recommend, explainTea, tLabel };
})(typeof window !== 'undefined' ? window : globalThis);
