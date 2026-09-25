/**
 * 送信先の台帳が**実態と合っている**ことを測る（go-decision G-D2、review r2 H1 / M8）。
 *
 * README の文言を grep で固定するだけでは「その文がある」しか測れない。
 * ここは**許可リスト方式** = ソースに現れる外部ホストのうち、台帳にも
 * 「送信先ではない」一覧にも無いものがあれば赤。新しい `fetch` 先を足した瞬間に落ちる。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  EGRESS_DESTINATIONS,
  NON_EGRESS_HOSTS,
  activeDestinations,
  registeredHosts,
  renderEgressScreen,
  renderEgressTable,
} from './egress.js';
import { PROVIDERS } from '../providers.js';
import { lintOutput } from '../guard/output-linter.js';

const SRC = join(import.meta.dir, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__fixtures__' || entry === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** ソースに literal で現れる https ホストを、ファイルごとに集める。 */
function literalHosts(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(/https:\/\/([a-zA-Z0-9._-]+)/g)) {
      const host = m[1];
      // 説明文の中の `https://...` のようなプレースホルダはホストではない
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) continue;
      const where = found.get(host) ?? [];
      where.push(file.slice(SRC.length + 1));
      found.set(host, where);
    }
  }
  return found;
}

describe('送信先の台帳 — 許可リスト方式', () => {
  test('★ ソースに現れる外部ホストは全部、台帳か「送信先ではない」一覧にある', () => {
    const registered = registeredHosts();
    const unregistered: Record<string, string[]> = {};
    for (const [host, files] of literalHosts()) {
      // 台帳のホストを接尾辞として持つもの（api.edinetdb.jp 等）も登録済みとみなす
      const known = registered.has(host) || [...registered].some(r => host.endsWith(`.${r}`));
      if (!known) unregistered[host] = files;
    }
    expect(unregistered).toEqual({});
  });

  test('台帳の主要ホストが実際にソースに現れる（台帳が絵空事でない）', () => {
    const hosts = literalHosts();
    for (const host of ['edinetdb.jp', 'api.typesafe.ai', 'api.jquants.com']) {
      expect({ host, present: hosts.has(host) }).toEqual({ host, present: true });
    }
  });

  test('「送信先ではない」一覧に、通信する先が紛れていない', () => {
    // deep link の TradingView は URL を組み立てるだけ。**同じ行で** fetch されていないことを見る。
    // ファイル単位の同居で判定すると、tweet の表示 URL や User-Agent の中の github.com を
    // 「通信している」と誤って読む（= 赤の理由が守りたい性質と対応しない）。
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        for (const { host } of NON_EGRESS_HOSTS) {
          if (!line.includes(`https://${host}`)) continue;
          if (/\bfetch\s*\(|\baxios\b|\brequest\s*\(/.test(line)) {
            offenders.push(`${file.slice(SRC.length + 1)}:${i + 1} で ${host} を取得しようとしている`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test('その同居チェックに判別力がある（fetch している行を入れれば赤になる）', () => {
    const line = `  await fetch('https://jp.tradingview.com/api/x');`;
    const wouldFlag = NON_EGRESS_HOSTS.some(
      ({ host }) => line.includes(`https://${host}`) && /\bfetch\s*\(/.test(line),
    );
    expect(wouldFlag).toBe(true);
  });

  test('LLM プロバイダの一覧は providers.ts が正本で、台帳はそれを 1 行で指す', () => {
    // プロバイダごとにホストを書き写すと二重管理になるので、台帳は hosts を空にして
    // providers.ts を正本にしている。ここでは「正本が空になっていない」ことだけ固定する。
    expect(PROVIDERS.length).toBeGreaterThan(3);
    expect(EGRESS_DESTINATIONS.find(d => d.id === 'llm-provider')?.hosts).toEqual([]);
  });
});

describe('起動画面（G-D2）— 実際に起動経路から出る（review T9 H4）', () => {
  test('★ cli.ts が起動時に renderEgressScreen(process.env) を画面の木に載せる', async () => {
    const src = await Bun.file(new URL('../cli.ts', import.meta.url)).text();
    // コメント内の言及では通らないよう、呼び出しと木への追加の 2 つを実コードの形で見る
    // ブロックコメントと行コメントを落としてから見る（Codex T9 L1）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    expect(code).toMatch(/new Text\([^\n]*renderEgressScreen\(process\.env\)/);
    expect(code).toMatch(/root\.addChild\(egressText\)/);
  });
});

describe('起動画面（G-D2）— プロバイダの切り替えに追随する', () => {
  test('鍵が無ければ「外には出ません」', () => {
    const lines = renderEgressScreen({} as NodeJS.ProcessEnv);
    // llm-provider は常に有効扱いなので、その 1 件だけが出る
    expect(lines.join('\n')).toContain('選択中の LLM プロバイダ');
    expect(lines.join('\n')).not.toContain('TypeSafe');
  });

  test('TYPESAFE_API_KEY を足すと一覧に TypeSafe が増える', () => {
    const before = renderEgressScreen({} as NodeJS.ProcessEnv).join('\n');
    const after = renderEgressScreen({ TYPESAFE_API_KEY: 'x' } as NodeJS.ProcessEnv).join('\n');
    expect(before).not.toContain('TypeSafe');
    expect(after).toContain('TypeSafe（Jev、米国）');
  });

  test('★ OPENAI_API_KEY だけで、会話履歴の埋め込みが一覧に出る（選択中の LLM と独立）', () => {
    const screen = renderEgressScreen({ OPENAI_API_KEY: 'x' } as NodeJS.ProcessEnv).join('\n');
    expect(screen).toContain('会話履歴の埋め込み');
    expect(screen).toContain('選択中の LLM とは独立に決まります');
  });

  test('LANGSMITH_TRACING=1 のときだけ LangSmith が出る', () => {
    expect(renderEgressScreen({} as NodeJS.ProcessEnv).join('\n')).not.toContain('LangSmith');
    expect(
      renderEgressScreen({ LANGSMITH_TRACING: '1' } as NodeJS.ProcessEnv).join('\n'),
    ).toContain('LangSmith');
  });

  test('既定で有効な送信先が 2 つ以上ある（「鍵を入れるまで何も出ない」と書けない）', () => {
    const onByDefault = EGRESS_DESTINATIONS.filter(d => d.onByDefault);
    expect(onByDefault.map(d => d.id).sort()).toEqual([
      'edinetdb',
      'llm-provider',
      'memory-embeddings',
    ]);
  });

  test('各送信先が「何が送られるか」を空でなく持っている', () => {
    for (const d of EGRESS_DESTINATIONS) {
      expect({ id: d.id, ok: d.whatIsSent.length > 10 }).toEqual({ id: d.id, ok: true });
      expect({ id: d.id, ok: d.enabledWhen.length > 0 }).toEqual({ id: d.id, ok: true });
    }
  });
});

describe('README の表', () => {
  test('台帳の全件が行になる', () => {
    const table = renderEgressTable();
    for (const d of EGRESS_DESTINATIONS) {
      expect({ id: d.id, inTable: table.includes(d.label) }).toEqual({ id: d.id, inTable: true });
    }
  });

  test('★ README.md の表は台帳から生成した表と一字一句同じ（review T9 M3。台帳を直したら README も直す）', async () => {
    const readme = await Bun.file(new URL('../../README.md', import.meta.url)).text();
    const lines = readme.split(/\r?\n/);
    const start = lines.findIndex(l => l.startsWith('| 送信先 | 何が送られるか |'));
    expect(start).toBeGreaterThanOrEqual(0);
    let end = start;
    while (end < lines.length && lines[end].startsWith('|')) end++;
    expect(lines.slice(start, end).join('\n')).toBe(renderEgressTable());
  });

  test('当社生成の文字列なので出力 linter を通る', () => {
    expect(lintOutput(renderEgressTable(), '$.readmeTable').findings).toEqual([]);
    expect(lintOutput(renderEgressScreen({} as NodeJS.ProcessEnv), '$.screen').findings).toEqual([]);
  });
});

describe('activeDestinations — 台帳の全 id に判定がある', () => {
  test('どの id も switch の default に落ちていない（足して書き忘れると常に非表示になる）', () => {
    const allEnv = {
      EDINETDB_API_KEY: 'x', TYPESAFE_API_KEY: 'x', OPENAI_API_KEY: 'x',
      LANGSMITH_TRACING: '1', JQUANTS_API_KEY: 'x', TAVILY_API_KEY: 'x',
      X_BEARER_TOKEN: 'x', OLLAMA_BASE_URL: 'x', OPENROUTER_API_KEY: 'x',
      MOONSHOT_API_KEY: 'x', DEEPSEEK_API_KEY: 'x',
    } as NodeJS.ProcessEnv;
    const active = activeDestinations(allEnv).map(d => d.id);
    const expected = EGRESS_DESTINATIONS
      .filter(d => d.id !== 'messaging-gateways') // ゲートウェイ起動時にだけ出す
      .map(d => d.id);
    expect(active.sort()).toEqual(expected.sort());
  });
});

describe('ツールを有効にする鍵は、どれも送信先一覧に載る（Codex T9 H4 + 同型の全走査）', () => {
  test('★ registry.ts / stock-price.ts / embeddings.ts / providers.ts が読む鍵の全部で、一覧に固有の送信先が出る', async () => {
    const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
    const names = new Set<string>();
    for (const f of ['../tools/registry.ts', '../tools/finance/stock-price.ts', '../memory/embeddings.ts']) {
      for (const m of (await read(f)).matchAll(/process\.env\.([A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN|_BASE_URL))/g)) names.add(m[1]);
    }
    for (const m of (await read('../providers.ts')).matchAll(/apiKeyEnvVar:\s*'([A-Z0-9_]+)'/g)) names.add(m[1]);
    expect(names.size).toBeGreaterThanOrEqual(12); // 走査が空振りしていない
    const base = new Set(activeDestinations({} as NodeJS.ProcessEnv).map(d => d.id));
    for (const name of names) {
      const lit = activeDestinations({ [name]: 'x' } as NodeJS.ProcessEnv).map(d => d.id).filter(id => !base.has(id));
      // LLM プロバイダの鍵は「選択中の LLM プロバイダ」（既定で有効）に含まれるので、新たに増えなくてよい
      const isLlmKey = /^(OPENAI|ANTHROPIC|GOOGLE|XAI|MOONSHOT|DEEPSEEK|OPENROUTER|OLLAMA_CLOUD)_API_KEY$/.test(name);
      expect({ name, covered: lit.length > 0 || isLlmKey }).toEqual({ name, covered: true });
    }
  });

  test('★ Exa / J-Quants / X / Ollama Cloud は実装と同じ鍵名で一覧に出る', () => {
    const ids = (env: Record<string, string>) => activeDestinations(env as NodeJS.ProcessEnv).map(d => d.id);
    expect(ids({ EXASEARCH_API_KEY: 'x' })).toContain('web-search');
    expect(ids({ JQUANTS_API_KEY: 'x' })).toContain('jquants');
    expect(ids({ X_BEARER_TOKEN: 'x' })).toContain('x-search');
    expect(ids({ OLLAMA_CLOUD_API_KEY: 'x' })).toContain('ollama');
  });
});
