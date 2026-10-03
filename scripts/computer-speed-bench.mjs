#!/usr/bin/env node
/*
 * 画面操作のモデル呼び出しを**実測で分解する**ための計測器。製品経路ではない。
 *
 * なぜ要るか: 決定は「その写真がまだ新しいうち」(60 秒) に返らなければ捨てられる。
 * 2026-09-20 の実測では 1 回 74〜109 秒かかり、**操作を 1 つも送れないまま**
 * 走行が終わっていた。どこで時間を使っているのかが分からないと、
 * モデルを替えるべきか、渡す画像を小さくすべきか、設定を変えるべきかが決められない。
 *
 * 分けて測るもの（Ollama の native /api/chat が返す値をそのまま使う）:
 *   load      モデルの読み込み       load_duration
 *   prompt    入力（画像と指示）の処理 prompt_eval_duration / prompt_eval_count
 *   generate  出力の生成             eval_duration / eval_count
 *   total     呼び出し全体            total_duration（待ち行列と転送を含む）
 *
 * 併せて残すもの: 実際の推論設定、画像の実寸とバイト数、モデルの識別情報
 * （名前・digest・パラメータ数・量子化）。同じ名前でも中身が違えば比べられない。
 *
 * 正解はプロンプトに入れない。判定はこちらが返り値の形だけを見て行う。
 * 使い方:
 *   node scripts/computer-speed-bench.mjs --model qwen3.5:9b --repeat 3
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const HOST = args.get('host') ?? 'http://127.0.0.1:11434';
const MODEL = args.get('model') ?? 'qwen3.5:9b';
const REPEAT = Number(args.get('repeat') ?? 3);
const OUT = args.get('out') ?? '';

const { visionPromptFor } = await import(new URL('../workers/agent-host/dist/computer-vision-prompts.js', import.meta.url));

/** 実際に使っている画面の写真。合成画像では入力処理の時間が実態とずれる。 */
const IMAGES = [
  'docs/quality/evidence/2026-09-20-computer/completed-field.png',
  'docs/quality/evidence/2026-09-20-computer/marker-small-target.png',
  'docs/quality/evidence/2026-09-20-computer/marker-during-run.png',
];

function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}

/*
 * 測る仕事。**正解はここに持ち、プロンプトへは渡さない。**
 * 判定は返ってきた JSON の形だけを見る——文言の一致ではなく、
 * 「この状況で許される答えかどうか」で見る。
 */
const TASKS = [
  /*
   * 正解は、画像に実際に写っているものから決めている（`completed-field.png` を目視で確認）:
   *   ふつうの欄 = "genie"（入っている） / 伏せ字の欄 = 空（placeholder のみ）
   *   検索の欄 = "secret"（入っている） / 複数行 = "genie"（入っている）
   * 画像の中身を確かめずに正解を置くと、モデルではなく出題を測ることになる。
   */
  {
    // 既に満たされている目的。**done が正解**。動かす必要のない画面で動かさないこと。
    name: 'plan-already-done',
    tool: 'llm.plan_computer_action',
    image: 0,
    args: {
      goal: '「ふつうの欄」に genie と入力する',
      successCriteria: 'ふつうの欄に genie と表示されている',
      turn: 1,
      candidates: [
        { id: 'e0-1', role: 'AXTextField', name: 'ふつうの欄' },
        { id: 'e0-2', role: 'AXTextArea', name: '複数行' },
      ],
    },
    accept: (r) => r?.action === 'done',
  },
  {
    /*
     * 満たされていない目的。**done は不正解**——これが 2026-09-20 に走行を終わらせた
     * 失敗そのもの（画面に無いものを「もう出ている」と言った）。
     */
    name: 'plan-not-done-yet',
    tool: 'llm.plan_computer_action',
    image: 0,
    args: {
      goal: '画面に「保存しました」という文字を表示させる',
      successCriteria: '画面のどこかに「保存しました」と表示されている',
      turn: 1,
      candidates: [
        { id: 'e0-1', role: 'AXTextField', name: 'ふつうの欄' },
        { id: 'e0-2', role: 'AXTextArea', name: '複数行' },
      ],
    },
    accept: (r) => r?.action !== 'done',
  },
  {
    /*
     * 未達成の条件を渡したとき、**そこへ向かうこと**。
     * 条件 1（伏せ字の欄）は実際に空。done を返したら、渡した情報を使っていない。
     * 伏せ字の欄は helper が送る前に断るので、ここで測るのは判断の向きだけ。
     */
    name: 'plan-follows-unmet',
    tool: 'llm.plan_computer_action',
    image: 0,
    args: {
      goal: '欄を埋める',
      successCriteria: 'ふつうの欄と複数行の両方に文字が入っている',
      turn: 1,
      criteriaList: ['ふつうの欄に文字が入っている', '複数行の欄に文字が入っている'],
      unmet: [1],
      verifierEvidence: '複数行の欄は空のままで、文字が入っていない',
      candidates: [
        { id: 'e0-1', role: 'AXTextField', name: 'ふつうの欄' },
        { id: 'e0-2', role: 'AXTextArea', name: '複数行' },
      ],
    },
    accept: (r) => r?.action !== 'done' && r?.action !== 'stop',
  },
  {
    // 目的は実際に満たされている。**satisfied が正解**。
    name: 'verify-satisfied',
    tool: 'llm.verify_computer_action',
    image: 0,
    args: {
      goal: '「ふつうの欄」に genie と入力する',
      successCriteria: 'ふつうの欄に genie と表示されている',
      phase: 'goal',
      criteriaList: ['ふつうの欄に genie と表示されている'],
    },
    accept: (r) => r?.outcome === 'satisfied',
  },
  {
    /*
     * 画面のどこにも無い文字。**satisfied を返したら不正解**——
     * ここが緩むと、部分的な結果が完了として通る。
     *
     * 最初は「伏せ字の欄が埋まっている」で測ったが、あの欄は灰色の placeholder
     * （"password"）を出していて、**人が見ても埋まって見える。**
     * 出題の側が曖昧なままでは、モデルの甘さを測ったことにならないので差し替えた。
     * 「保存しました」は画像のどこにも無く、見間違えようがない。
     */
    name: 'verify-absent-text',
    tool: 'llm.verify_computer_action',
    image: 0,
    args: {
      goal: '保存する',
      successCriteria: '画面に「保存しました」と表示されている',
      phase: 'goal',
      criteriaList: ['画面に「保存しました」と表示されている'],
    },
    accept: (r) => r?.outcome !== 'satisfied',
  },
  {
    /*
     * 大きな画像での所要時間だけを見る。この画像の中身は確かめていないので、
     * **正解は置かない**——形が通ったかどうかだけを数える。
     */
    name: 'plan-large-image-shape-only',
    tool: 'llm.plan_computer_action',
    image: 2,
    args: {
      goal: '画面の入力欄に文字を入れる',
      successCriteria: '入力欄に文字が入っている',
      turn: 0,
      candidates: [{ id: 'e2-1', role: 'AXTextField', name: 'ふつうの欄' }],
    },
    shapeOnly: true,
    accept: (r) => ['click', 'type', 'type_keys', 'key', 'done', 'stop'].includes(r?.action),
  },
];

async function chat({ prompt, image, think }) {
  const body = {
    model: MODEL,
    stream: false,
    think,
    format: 'json',
    options: { temperature: 0 },
    messages: [{ role: 'user', content: prompt, images: [image.toString('base64')] }],
  };
  const started = process.hrtime.bigint();
  const response = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const data = await response.json();
  const wall = Number(process.hrtime.bigint() - started) / 1e6;
  let parsed = null;
  try {
    parsed = JSON.parse(data.message?.content ?? '');
  } catch {
    /* 形が壊れた返答も測定対象。accept が false になるだけ。 */
  }
  const ms = (n) => (typeof n === 'number' ? Math.round(n / 1e6) : null);
  return {
    wallMs: Math.round(wall),
    totalMs: ms(data.total_duration),
    loadMs: ms(data.load_duration),
    promptMs: ms(data.prompt_eval_duration),
    generateMs: ms(data.eval_duration),
    promptTokens: data.prompt_eval_count ?? null,
    generatedTokens: data.eval_count ?? null,
    parsed,
  };
}

const info = await (await fetch(`${HOST}/api/show`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: MODEL }),
})).json();

const images = await Promise.all(IMAGES.map((p) => readFile(new URL('../' + p, import.meta.url))));
const report = {
  measuredAt: new Date().toISOString(),
  host: HOST,
  /** 同じ名前でも中身が違えば比べられない。digest まで残す。 */
  model: {
    name: MODEL,
    digest: info?.details?.digest ?? info?.model_info?.['general.basename'] ?? null,
    parameterSize: info?.details?.parameter_size ?? null,
    quantization: info?.details?.quantization_level ?? null,
    family: info?.details?.family ?? null,
    contextLength: info?.model_info?.[`${info?.details?.family}.context_length`] ?? null,
  },
  /** 実際に送った推論設定。既定値を書き写さず、送った値をそのまま残す。 */
  inference: { temperature: 0, format: 'json', stream: false },
  images: IMAGES.map((path, i) => ({ path, ...pngSize(images[i]), sha256: createHash('sha256').update(images[i]).digest('hex').slice(0, 16) })),
  repeat: REPEAT,
  runs: [],
};

/** 測る推論設定。think は 60 秒の窓を超えることが分かっているので、絞って測れるようにする。 */
const MODES = (args.get('modes') ?? 'think,nothink').split(',').map((m) => m.trim() === 'think');
for (const think of MODES) {
  for (const task of TASKS) {
    for (let i = 0; i < REPEAT; i++) {
      const prompt = visionPromptFor(task.tool, {
        ...task.args,
        frames: [{ id: 'cv-bench', width: pngSize(images[task.image]).width, height: pngSize(images[task.image]).height }],
        images: [{ id: 'cv-bench', kind: 'screenshot', label: 'CURRENT' }],
        observation: { deliveryMode: 'background' },
      });
      /*
       * 正解がプロンプトへ漏れていないことを、**毎回**確かめる。
       * 測定のために足した情報が答えを教えていたら、速さも品質も意味を失う。
       */
      const leak = String(task.accept);
      if (prompt.includes('accept') || (task.answerToken && prompt.includes(task.answerToken)))
        throw new Error(`answer leaked into prompt for ${task.name}`);
      void leak;
      let result;
      try {
        result = await chat({ prompt, image: images[task.image], think });
      } catch (error) {
        result = { error: String(error).slice(0, 200) };
      }
      const accepted = result.parsed ? Boolean(task.accept(result.parsed)) : false;
      report.runs.push({
        task: task.name,
        ...(task.shapeOnly ? { shapeOnly: true } : {}),
        tool: task.tool,
        think,
        attempt: i,
        imageIndex: task.image,
        promptChars: prompt.length,
        accepted,
        action: result.parsed?.action ?? result.parsed?.outcome ?? null,
        wallMs: result.wallMs ?? null,
        totalMs: result.totalMs ?? null,
        loadMs: result.loadMs ?? null,
        promptMs: result.promptMs ?? null,
        generateMs: result.generateMs ?? null,
        promptTokens: result.promptTokens ?? null,
        generatedTokens: result.generatedTokens ?? null,
        ...(result.error ? { error: result.error } : {}),
      });
      process.stderr.write(
        `${think ? 'think ' : 'nothink'} ${task.name.padEnd(28)} ${String(result.wallMs ?? '-').padStart(6)}ms ` +
          `load=${result.loadMs ?? '-'} prompt=${result.promptMs ?? '-'} gen=${result.generateMs ?? '-'} ` +
          `tok=${result.generatedTokens ?? '-'} ok=${accepted}\n`,
      );
    }
  }
}

/** 集計は中央値で見る。1 回の外れ値で結論を変えないため。 */
const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
report.summary = MODES.flatMap((think) =>
  TASKS.map((task) => {
    const rows = report.runs.filter((r) => r.think === think && r.task === task.name);
    return {
      think,
      task: task.name,
      /** 正解を置いていない出題は、品質ではなく形だけを数えていると分かるようにする。 */
      ...(task.shapeOnly ? { shapeOnly: true } : {}),
      runs: rows.length,
      accepted: rows.filter((r) => r.accepted).length,
      medianWallMs: median(rows.map((r) => r.wallMs)),
      medianPromptMs: median(rows.map((r) => r.promptMs)),
      medianGenerateMs: median(rows.map((r) => r.generateMs)),
      medianGeneratedTokens: median(rows.map((r) => r.generatedTokens)),
    };
  }),
);
/*
 * 鮮度の窓に入るか。**ここを緩めて見かけの成功率を上げてはいけない**ので、
 * 60 秒は測定側でも動かさず、入ったかどうかだけを数える。
 */
report.freshnessWindowMs = 60_000;
report.withinFreshness = Object.fromEntries(
  MODES.map((think) => [
    think ? 'think' : 'nothink',
    report.runs.filter((r) => r.think === think && typeof r.wallMs === 'number' && r.wallMs <= 60_000).length,
  ]),
);

const text = JSON.stringify(report, null, 2);
if (OUT) {
  await mkdir(dirname(resolve(OUT)), { recursive: true });
  await writeFile(resolve(OUT), text + '\n');
  process.stderr.write(`\nwrote ${OUT}\n`);
} else process.stdout.write(text + '\n');
