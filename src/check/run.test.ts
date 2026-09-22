/**
 * `/check` を**端から端まで**（録画の再生で）回す。design §4.2 の順番がそのまま通ることを見る。
 * 外部通信はゼロ（判定層は注入、EDINET DB と LLM はポート）。
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck, type CheckPorts, type DisclosureSource } from './index.js';
import { lintOutput } from '../guard/output-linter.js';
import { JudgeUnavailableError } from '../judge/errors.js';
import type { JudgeBackend } from '../judge/index.js';
import type { RawClaimFromModel } from './core/index.js';

const COMPANY = { name: '株式会社ファーストリテイリング', edinetCode: 'E03217', secCode: '9983' };

const PARAGRAPHS = [
  {
    id: 'p1',
    docId: 'S100X6X6',
    company: COMPANY.name,
    edinetCode: COMPANY.edinetCode,
    filer: COMPANY.name,
    docType: '有価証券報告書',
    section: 'mda',
    fiscalYear: 2025,
    text: '当第４四半期連結会計期間の事業利益は、売上総利益率と売上高販管費比率が改善したことで、約11％増益となりました。',
  },
  {
    id: 'p2',
    docId: 'S100X6X6',
    company: COMPANY.name,
    edinetCode: COMPANY.edinetCode,
    filer: COMPANY.name,
    docType: '有価証券報告書',
    section: 'risks',
    fiscalYear: 2025,
    text: '当社株式が市場において割高に評価された場合、資金調達の条件が悪化する可能性があります。',
  },
];

const DISCLOSURE: DisclosureSource = {
  company: COMPANY,
  fiscalYear: 2025,
  sections: ['mda', 'risks', 'policy'],
  paragraphs: PARAGRAPHS,
};

/**
 * 録画の再生に見立てた判定層（backend 名が `replay` = `/check` が走ってよい側）。
 *
 * 表は**段落 ID** で引く。主張の ID は `extractClaims` が採番する（`c1-1` 等）ので、
 * 表を主張 ID で引く形にすると採番の変更で黙って全部 `unresolved` になる
 * （= テストが壊れているのに「判定不能」として通ってしまう）。
 */
function recordedJudge(byParagraph: Record<string, { choice: string; confidence: number }>): JudgeBackend {
  return {
    name: 'replay',
    call: async (request) => {
      const rec = byParagraph[request.key];
      if (!rec) throw new Error(`録画がありません: ${request.key}`);
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((q) => [
            q,
            {
              type: 'choice' as const,
              backend: 'jev' as const,
              choice: rec.choice,
              confidence: rec.confidence,
              probabilities: { [rec.choice]: rec.confidence, other: 1 - rec.confidence },
            },
          ]),
        ),
        inputTokens: 120,
      };
    },
  };
}

/** Noul（入口ガードの票）も同じ backend から返る形にする。 */
function judgeWithVote(
  byParagraph: Record<string, { choice: string; confidence: number }>,
  noul: number,
): JudgeBackend {
  const inner = recordedJudge(byParagraph);
  return {
    name: 'replay',
    call: async (request) => {
      if (request.key === 'guard') {
        return {
          answers: { advice: { type: 'noul', backend: 'jev', noul, probabilities: { true: noul, false: 1 - noul } } },
          inputTokens: 20,
        };
      }
      return inner.call(request);
    },
  };
}

const RAW_CLAIM: RawClaimFromModel = {
  quote: '第 4 四半期は増益だった',
  text: 'ファーストリテイリングの FY2025 第 4 四半期の事業利益は増益だった',
  company: COMPANY.name,
  period: 'FY2025',
};

let recordDir: string;
const made: string[] = [];

beforeEach(() => {
  recordDir = mkdtempSync(join(tmpdir(), 'dexter-checks-'));
  made.push(recordDir);
});

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function ports(over: Partial<CheckPorts> = {}): CheckPorts {
  return {
    judge: judgeWithVote({ p1: { choice: 'supports', confidence: 0.94 }, p2: { choice: 'unrelated', confidence: 0.99 } }, 0.02),
    decompose: async () => [RAW_CLAIM],
    fetchDisclosure: async () => DISCLOSURE,
    recordDir,
    ...over,
  };
}

describe('端から端まで（録画の再生）', () => {
  test('仮説 → 主張 → 証拠 → 範囲 → deep link → 記録 まで通る', async () => {
    const out = await runCheck('9983', '第 4 四半期は増益だったと会社は説明している', ports());
    expect(out.kind).toBe('panel');
    if (out.kind !== 'panel') throw new Error('unreachable');

    expect(out.panel.claims).toHaveLength(1);
    expect(out.panel.claims[0].status).toBe('supports');
    expect(out.panel.claims[0].supporting[0].docId).toBe('S100X6X6');
    expect(out.panel.scope.total).toBe(2);
    expect(out.panel.scope.unchecked).toBe(0);
    expect(out.panel.links).toHaveLength(2);
    expect(out.panel.undetermined).toBe(false);
  });

  test('記録が `.dexter/checks/` 相当に 1 本書かれる', async () => {
    const out = await runCheck('9983', '第 4 四半期は増益だったと会社は説明している', ports());
    if (out.kind !== 'panel') throw new Error('unreachable');
    expect(readdirSync(recordDir)).toHaveLength(1);
    const saved = JSON.parse(readFileSync(out.recordPath, 'utf-8'));
    expect(saved.version).toBe(1);
    expect(saved.judgeBackend).toBe('replay');
    expect(saved.panel.hypothesis.kind).toBe('quote');
  });

  test('★ 記録 JSON の当社生成フィールドに禁止語が無い（有報の「割高」は逐語なので通る）', async () => {
    // 「割高」を含む p2 を**証拠として載せる**構成にする。unrelated だとパネルに入らず、
    // 「逐語に禁止語があっても緑」を測ったことにならない（陽性対照が無い状態になる）。
    const out = await runCheck('9983', '第 4 四半期は増益だったと会社は説明している', ports({
      judge: judgeWithVote({ p1: { choice: 'supports', confidence: 0.94 }, p2: { choice: 'contradicts', confidence: 0.91 } }, 0.02),
    }));
    if (out.kind !== 'panel') throw new Error('unreachable');
    const saved = JSON.parse(readFileSync(out.recordPath, 'utf-8'));
    // 有報の「割高」を含む段落は記録にも入っているが、quote 型なので走査されない
    expect(JSON.stringify(saved)).toContain('割高');
    expect(lintOutput(saved, '$.record').findings).toEqual([]);
  });
});

describe('入口ガード（G-A1）', () => {
  test('助言を求める入力は判定に到達せず、言い換えが出る', async () => {
    const out = await runCheck('9983', 'トヨタは今買いですか？', ports());
    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') throw new Error('unreachable');
    expect(out.verdict.by).toBe('vocabulary');
    expect(out.verdict.suggestions.length).toBeGreaterThanOrEqual(2);
  });

  test('★ 非対話モードでは提案せず拒否で終わる（進むと赤）', async () => {
    const out = await runCheck('9983', 'そろそろ利確したほうがいい？', ports(), { interactive: false });
    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') throw new Error('unreachable');
    expect(out.verdict.suggestions).toEqual([]);
  });

  test('判定層の票だけで止まる入力もある（語彙にも構造にも当たらない）', async () => {
    const out = await runCheck('9983', 'この会社のリスク記述は去年から変わった？', ports({
      judge: judgeWithVote({}, 0.97),
    }));
    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') throw new Error('unreachable');
    expect(out.verdict.by).toBe('judge');
  });

  test('★ 票が取れないときは走らず例外が上がる（素通りしない）', async () => {
    const broken: JudgeBackend = {
      name: 'replay',
      call: async () => {
        throw new Error('録画がありません');
      },
    };
    await expect(
      runCheck('9983', 'この会社のリスク記述は去年から変わった？', ports({ judge: broken })),
    ).rejects.toBeInstanceOf(JudgeUnavailableError);
  });
});

describe('判定層が LLM 代行なら走らせない（裁定 B）', () => {
  test('★ backend が llm なら判定にも取得にも進まない', async () => {
    let fetched = false;
    const out = await runCheck('9983', '第 4 四半期は増益だった', ports({
      judge: { name: 'llm', call: async () => ({ answers: {}, inputTokens: 0 }) },
      fetchDisclosure: async () => {
        fetched = true;
        return DISCLOSURE;
      },
    }));
    expect(out.kind).toBe('judge_unavailable');
    expect(fetched).toBe(false); // 取得にも入らない = 鍵を無駄に使わない
    if (out.kind !== 'judge_unavailable') throw new Error('unreachable');
    expect(out.message).toContain('TYPESAFE_API_KEY');
  });
});

describe('判定不能（G-A3）', () => {
  test('★ 全部が閾値未満なら判定不能で、要約も出ない', async () => {
    let summarized = false;
    const out = await runCheck('9983', '第 4 四半期は増益だったと会社は説明している', ports({
      judge: judgeWithVote({ p1: { choice: 'supports', confidence: 0.55 }, p2: { choice: 'unrelated', confidence: 0.99 } }, 0.02),
      summarize: async () => {
        summarized = true;
        return 'おそらく増益でしょう。';
      },
    }));
    if (out.kind !== 'panel') throw new Error('unreachable');
    expect(out.panel.undetermined).toBe(true);
    expect(out.panel.summary).toBeNull();
    expect(summarized).toBe(false); // 呼びにすら行かない
  });

  test('対象節が空でも落ちずに判定不能で返る', async () => {
    const out = await runCheck('9983', '第 4 四半期は増益だった', ports({
      fetchDisclosure: async () => ({ ...DISCLOSURE, paragraphs: [] }),
    }));
    if (out.kind !== 'panel') throw new Error('unreachable');
    expect(out.panel.undetermined).toBe(true);
    expect(out.panel.scope.total).toBe(0);
  });
});

describe('引数', () => {
  test('銘柄だけ / 空なら使い方を出す（黙って何も起きない、をやめる）', async () => {
    expect((await runCheck('9983', '', ports())).kind).toBe('usage');
    expect((await runCheck('', '仮説', ports())).kind).toBe('usage');
  });
});
