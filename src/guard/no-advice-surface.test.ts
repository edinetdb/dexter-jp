/**
 * R1「答え合わせ」で外した売買判断の面が、戻っていないことを固定する。
 *
 * 由来: 小池裁定 2026-09-22（kickoff §3-2 / design v0.5 §4.4）。本家 upstream 由来の
 * 3 か所が「利用者の建玉方向・売買履歴・推奨」を前提にしていたため R1 で外した。
 *   1. src/skills/write-memo/  — long / short の投資メモ（ヘッダに recommendation）
 *   2. src/memory/flush.ts     — 「売買履歴と buy/sell の理由・口座情報を優先して記憶せよ」
 *   3. src/agent/prompts.ts    — 「buy/sell decisions, portfolio suggestions, stock
 *                                 recommendations, or trade sizing を与える前に memory_search」
 *
 * README の「`/check`・`/watch` は売買の指示・目標株価・建玉の大きさを出力しません」は
 * 機能限定の事実文だが、既定で走るプロンプトが売買助言を前提にしていると実態と食い違う
 * （go-decision E-5）。ここで機械的に固定する。
 */
import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from '../agent/prompts.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { discoverSkills, clearSkillCache } from '../skills/registry.js';

/** 売買・推奨・建玉サイズの語。既定で走る当社生成のプロンプトに現れてはいけない。 */
const ADVICE_PHRASES = [
  'buy/sell',
  'trade sizing',
  'position limits',
  'portfolio suggestions',
  'stock recommendations',
  'recommendation',
  'pitch this stock',
  'long or short equity',
  'long writeup',
  'short writeup',
  'allocation changes',
  'trade history',
  'financial advice',
  '売買',
  '建玉',
  '推奨銘柄',
];

function offenders(text: string): string[] {
  const lower = text.toLowerCase();
  return ADVICE_PHRASES.filter(p => lower.includes(p.toLowerCase()));
}

describe('R1 で外した売買判断の面が戻っていない', () => {
  test('自動 memory flush を復活させない（明示依頼による記憶のみ）', () => {
    expect(existsSync(join(import.meta.dir, '../memory/flush.ts'))).toBe(false);
  });

  test('システムプロンプト（既定・全チャネル）に売買助言の前提が無い', () => {
    expect(offenders(DEFAULT_SYSTEM_PROMPT)).toEqual([]);
    for (const channel of [undefined, 'cli', 'slack', 'discord', 'whatsapp', 'line']) {
      const prompt = buildSystemPrompt('claude-sonnet-4-5', null, channel, undefined, ['MEMORY.md'], null, null,
        new Set(['memory_search', 'memory_get', 'memory_update']));
      expect({ channel, hits: offenders(prompt) }).toEqual({ channel, hits: [] });
    }
  });

  test('システムプロンプトは memory_search の指示自体は残している', () => {
    const prompt = buildSystemPrompt('claude-sonnet-4-5', null, 'cli', undefined, ['MEMORY.md'], null, null,
      new Set(['memory_search']));
    expect(prompt).toContain('memory_search');
  });

  test('builtin スキルに建玉方向の推奨メモ（write-memo）が無い', () => {
    clearSkillCache();
    const builtins = discoverSkills({ availableTools: new Set(['calculate_dcf', 'x_search', 'write_memo']) })
      .filter(s => s.source === 'builtin');
    expect(builtins.map(s => s.name)).not.toContain('write-memo');
    for (const skill of builtins) {
      expect({ skill: skill.name, hits: offenders(`${skill.name} ${skill.description}`) })
        .toEqual({ skill: skill.name, hits: [] });
    }
  });

  test('builtin スキルの発見機構自体は生きている（空にしたのではない）', () => {
    clearSkillCache();
    const builtins = discoverSkills({ availableTools: new Set(['calculate_dcf', 'x_search']) })
      .filter(s => s.source === 'builtin');
    expect(builtins.length).toBeGreaterThan(0);
  });

  test('明示依頼で公開されるメモも投資推奨を前提にしない', () => {
    clearSkillCache();
    const memo = discoverSkills({ availableTools: new Set(['write_memo']), userQuery: 'これをメモにして' })
      .find(s => s.name === 'write-memo');
    expect(memo).toBeDefined();
    expect(offenders(memo!.description)).toEqual([]);
  });
});
