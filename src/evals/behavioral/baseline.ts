import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OperationApprovalGate,
  decideOperationApproval,
  normalizeToolOperation,
} from '../../approval/operation-policy.js';
import { buildCompactionSource } from '../../agent/compact.js';
import { Scratchpad } from '../../agent/scratchpad.js';
import {
  buildMemoFilename,
  memoDocumentSchema,
  prepareWriteMemoInput,
  resolveMemoFilePath,
  sanitizeMemoFilenameTitle,
  type MemoDocument,
} from '../../memo/document.js';
import { renderMemo } from '../../memo/renderer.js';
import {
  DurableMemoryPersistence,
  EXPLICIT_MEMORY_UPDATE_ORIGIN,
} from '../../memory/persistence.js';
import { MemoryStore } from '../../memory/store.js';
import { discoverSkills } from '../../skills/registry.js';
import { createWriteMemoTool } from '../../tools/memo/write-memo.js';
import { calculateDcfAnalysis } from '../../tools/finance/calculate-dcf.js';
import { LongTermChatHistory } from '../../utils/long-term-chat-history.js';
import type {
  ArchitectureBaselineResult,
  BaselineCaseResult,
  EvalSuite,
} from './types.js';

interface BaselineCase {
  id: string;
  suite: EvalSuite;
  run: (root: string) => void | Promise<void>;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectThrow(fn: () => unknown, marker: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(message.includes(marker), `Expected error containing ${marker}; received ${message}`);
    return;
  }
  throw new Error(`Expected error containing ${marker}.`);
}

function safeRemoveTemp(path: string): void {
  const target = resolve(path);
  const temp = resolve(tmpdir());
  if (!target.startsWith(temp + sep)) throw new Error('Refusing to remove a non-temp eval directory.');
  rmSync(target, { recursive: true, force: true });
}

function memoryStore(root: string, suffix: string): MemoryStore {
  return new MemoryStore(join(root, suffix, '.dexter'));
}

const BASIC_MEMO: MemoDocument = {
  title: '評価メモ',
  summary: '確定した内容のみ。',
  keyPoints: ['要点A', '要点B'],
  tags: ['Phase7', '評価'],
};

const DCF_BASE = {
  forecastFreeCashFlows: [
    { period: 'FY2027', value: 100 },
    { period: 'FY2028', value: 110 },
    { period: 'FY2029', value: 120 },
  ],
  wacc: 0.08,
  terminalGrowthRate: 0.02,
  netDebt: 40,
  dilutedSharesOutstanding: 10_000_000,
  unit: 'JPY_million' as const,
  waccDelta: 0.01,
  growthDelta: 0.005,
};

const CASES: BaselineCase[] = [
  // Skill registry capability baseline
  {
    id: 'core.skill.capability-filtering', suite: 'skill-activation', run: () => {
      const none = discoverSkills({ availableTools: new Set() }).map((skill) => skill.name);
      const dcf = discoverSkills({ availableTools: new Set(['calculate_dcf']) }).map((skill) => skill.name);
      check(!none.includes('dcf-valuation'), 'DCF Skill leaked without calculator capability.');
      check(dcf.includes('dcf-valuation'), 'DCF Skill missing with calculator capability.');
    },
  },
  {
    id: 'core.skill.x-capability-filtering', suite: 'skill-activation', run: () => {
      const none = discoverSkills({ availableTools: new Set() }).map((skill) => skill.name);
      const x = discoverSkills({ availableTools: new Set(['x_search']) }).map((skill) => skill.name);
      check(!none.includes('x-research'), 'X Skill leaked without x_search.');
      check(x.includes('x-research'), 'X Skill missing with x_search.');
    },
  },
  {
    id: 'core.skill.memo-explicit-boundary', suite: 'skill-activation', run: () => {
      const tools = new Set(['write_memo']);
      const implicit = discoverSkills({ availableTools: tools, userQuery: '覚えておいて' }).map((skill) => skill.name);
      const explicit = discoverSkills({ availableTools: tools, userQuery: 'これをメモにして' }).map((skill) => skill.name);
      check(!implicit.includes('write-memo'), 'Memo Skill confused memory intent with memo intent.');
      check(explicit.includes('write-memo'), 'Memo Skill missing for explicit Japanese memo intent.');
    },
  },

  // Deterministic DCF baseline
  {
    id: 'core.dcf.valid', suite: 'dcf', run: () => {
      const result = calculateDcfAnalysis({
        forecastFreeCashFlows: [{ period: 'FY2027', value: 100 }],
        wacc: 0.1,
        terminalGrowthRate: 0.02,
        netDebt: 0,
        dilutedSharesOutstanding: 1_000_000,
        unit: 'JPY_million',
      });
      check(Math.abs(result.base.intrinsicValuePerShare - 1250) < 1e-9, 'Manually verifiable DCF changed.');
    },
  },
  {
    id: 'core.dcf.equal-rates', suite: 'dcf', run: () => {
      expectThrow(() => calculateDcfAnalysis({ ...DCF_BASE, wacc: 0.02, terminalGrowthRate: 0.02 }), 'WACC must be greater');
    },
  },
  {
    id: 'core.dcf.lower-wacc', suite: 'dcf', run: () => {
      expectThrow(() => calculateDcfAnalysis({ ...DCF_BASE, wacc: 0.01, terminalGrowthRate: 0.02 }), 'WACC must be greater');
    },
  },
  {
    id: 'core.dcf.negative-fcf', suite: 'dcf', run: () => {
      const result = calculateDcfAnalysis({
        ...DCF_BASE,
        forecastFreeCashFlows: [
          { period: 'FY2027', value: -20 },
          { period: 'FY2028', value: 100 },
        ],
      });
      check(result.base.assumptions.forecastFreeCashFlows[0]?.value === -20, 'Negative forecast FCF was not preserved.');
    },
  },
  {
    id: 'core.dcf.net-cash', suite: 'dcf', run: () => {
      const debt = calculateDcfAnalysis({ ...DCF_BASE, netDebt: 40 });
      const cash = calculateDcfAnalysis({ ...DCF_BASE, netDebt: -40 });
      check(cash.base.equityValue > debt.base.equityValue, 'Net cash did not increase equity value.');
    },
  },
  {
    id: 'core.dcf.sensitivity', suite: 'dcf', run: () => {
      const first = calculateDcfAnalysis(DCF_BASE);
      const second = calculateDcfAnalysis(DCF_BASE);
      check(first.sensitivity.rows.flatMap((row) => row.cells).length === 9, 'Sensitivity grid is not 3 x 3.');
      check(JSON.stringify(first) === JSON.stringify(second), 'DCF output is not deterministic.');
    },
  },

  // Approval policy baseline
  ...([
    ['core.approval.read', 'read_file', { path: 'note.md' }, 'read_only', 'none'],
    ['core.approval.local', 'edit_file', { path: 'note.md', old_text: 'a', new_text: 'b' }, 'local_mutation', 'user_approval'],
    ['core.approval.external', 'heartbeat', { action: 'update', content: '- check' }, 'external_mutation', 'user_approval'],
    ['core.approval.destructive', 'cron', { action: 'remove', jobId: 'job-1' }, 'destructive', 'user_approval'],
    ['core.approval.unknown', 'unknown_mutation', { target: 'resource' }, 'sensitive', 'user_approval'],
  ] as const).map(([id, tool, args, risk, requirement]): BaselineCase => ({
    id,
    suite: 'approval',
    run: (root) => {
      const operation = normalizeToolOperation(tool, args, { cwd: root, now: new Date('2026-01-15T12:00:00Z') });
      check(operation.risk === risk, `${id} risk changed.`);
      check(decideOperationApproval(operation).requirement === requirement, `${id} approval requirement changed.`);
    },
  })),
  {
    id: 'core.approval.same-tool-different-action', suite: 'approval', run: (root) => {
      const read = normalizeToolOperation('cron', { action: 'list' }, { cwd: root });
      const remove = normalizeToolOperation('cron', { action: 'remove', jobId: 'job-1' }, { cwd: root });
      check(read.risk === 'read_only' && remove.risk === 'destructive', 'Same-tool actions were not distinguished.');
      check(read.fingerprint !== remove.fingerprint, 'Different actions share a fingerprint.');
    },
  },
  {
    id: 'core.approval.changed-target', suite: 'approval', run: async (root) => {
      const gate = new OperationApprovalGate(async () => 'allow-once', new Set(), { cwd: root });
      await gate.authorize('edit_file', { path: 'approved.md', old_text: 'a', new_text: 'b' });
      expectThrow(() => gate.claim('edit_file', { path: 'other.md', old_text: 'a', new_text: 'b' }), 'not approved');
    },
  },
  {
    id: 'core.approval.changed-args', suite: 'approval', run: async (root) => {
      const gate = new OperationApprovalGate(async () => 'allow-once', new Set(), { cwd: root });
      await gate.authorize('write_file', { path: 'approved.md', content: 'approved' });
      expectThrow(() => gate.claim('write_file', { path: 'approved.md', content: 'changed' }), 'not approved');
    },
  },
  {
    id: 'core.approval.retry-identical', suite: 'approval', run: async (root) => {
      let prompts = 0;
      const gate = new OperationApprovalGate(async () => { prompts++; return 'allow-session'; }, new Set(), { cwd: root });
      const args = { path: 'note.md', old_text: 'a', new_text: 'b' };
      const first = await gate.authorize('edit_file', args);
      gate.claim('edit_file', args);
      const second = await gate.authorize('edit_file', args);
      gate.claim('edit_file', args);
      check(first.prompted && !second.prompted && prompts === 1, 'Identical session retry prompted incorrectly.');
    },
  },
  {
    id: 'core.approval.retry-changed', suite: 'approval', run: async (root) => {
      let prompts = 0;
      const gate = new OperationApprovalGate(async () => { prompts++; return 'allow-session'; }, new Set(), { cwd: root });
      const first = { path: 'note.md', old_text: 'a', new_text: 'b' };
      const changed = { ...first, new_text: 'c' };
      await gate.authorize('edit_file', first);
      gate.claim('edit_file', first);
      const second = await gate.authorize('edit_file', changed);
      gate.claim('edit_file', changed);
      check(second.prompted && prompts === 2, 'Changed retry reused the old approval.');
    },
  },

  // Privacy baseline
  {
    id: 'core.privacy.conversation-only', suite: 'privacy', run: async (root) => {
      const area = join(root, 'privacy-conversation');
      const history = new LongTermChatHistory(area);
      await history.load();
      await history.addUserMessage('temporary conversation');
      await history.updateAgentResponse('temporary answer');
      check((await memoryStore(root, 'privacy-conversation').listMemoryFiles()).length === 0, 'Conversation became durable memory.');
    },
  },
  {
    id: 'core.privacy.scratchpad', suite: 'privacy', run: async (root) => {
      const store = memoryStore(root, 'privacy-scratchpad');
      const scratchpad = new Scratchpad('query');
      scratchpad.addThinking('INTERNAL_SENTINEL');
      check((await store.listMemoryFiles()).length === 0, 'Scratchpad became durable memory.');
    },
  },
  {
    id: 'core.privacy.tool-result', suite: 'privacy', run: async (root) => {
      const store = memoryStore(root, 'privacy-tool-result');
      const scratchpad = new Scratchpad('query');
      scratchpad.addToolResult('read_filings', { ticker: '7203' }, 'temporary evidence');
      check(scratchpad.hasToolResults(), 'Scratchpad did not retain runtime tool output.');
      check((await store.listMemoryFiles()).length === 0, 'Tool output became durable memory.');
    },
  },
  {
    id: 'core.privacy.compaction', suite: 'privacy', run: async (root) => {
      const store = memoryStore(root, 'privacy-compaction');
      const source = buildCompactionSource([
        new HumanMessage('user-visible request'),
        new AIMessage({
          content: 'INTERNAL_SENTINEL',
          tool_calls: [{ id: 'call-1', name: 'read_filings', args: { ticker: '7203' } }],
        }),
        new AIMessage('visible conclusion'),
      ], 'tool evidence');
      check(!source.includes('INTERNAL_SENTINEL'), 'Compaction source exposed tool-calling reasoning.');
      check(source.includes('visible conclusion'), 'Compaction lost required conversation context.');
      check((await store.listMemoryFiles()).length === 0, 'Compaction became durable memory.');
    },
  },
  {
    id: 'core.privacy.explicit-memory-restart', suite: 'privacy', run: async (root) => {
      const store = memoryStore(root, 'privacy-explicit');
      const persistence = new DurableMemoryPersistence(store);
      await persistence.apply({
        origin: EXPLICIT_MEMORY_UPDATE_ORIGIN,
        action: 'append',
        file: 'MEMORY.md',
        content: '- Explicit preference',
      });
      const restarted = memoryStore(root, 'privacy-explicit');
      check((await restarted.readMemoryFile('MEMORY.md')).includes('Explicit preference'), 'Explicit memory did not survive restart.');
    },
  },
  {
    id: 'core.privacy.memo-isolation', suite: 'privacy', run: async (root) => {
      const area = join(root, 'privacy-memo');
      const tool = createWriteMemoTool({ cwd: area });
      await tool.invoke({ document: BASIC_MEMO, created: '2026-01-15' });
      check((await new MemoryStore(join(area, '.dexter')).listMemoryFiles()).length === 0, 'Memo silently mutated durable memory.');
    },
  },
  {
    id: 'core.privacy.restart-transient', suite: 'privacy', run: async (root) => {
      const store = memoryStore(root, 'privacy-restart');
      const persistence = new DurableMemoryPersistence(store);
      const scratchpad = new Scratchpad('query');
      scratchpad.addToolResult('read_filings', {}, 'transient');
      await persistence.apply({ origin: EXPLICIT_MEMORY_UPDATE_ORIGIN, action: 'append', file: 'MEMORY.md', content: '- Durable' });
      const restartedScratchpad = new Scratchpad('next query');
      const restartedStore = memoryStore(root, 'privacy-restart');
      check(!restartedScratchpad.hasToolResults(), 'Transient scratchpad survived restart.');
      check((await restartedStore.readMemoryFile('MEMORY.md')).includes('Durable'), 'Durable memory was lost on restart.');
    },
  },

  // Memo baseline
  {
    id: 'core.memo.japanese', suite: 'memo', run: () => {
      const rendered = renderMemo(BASIC_MEMO, { created: '2026-01-15' });
      check(rendered.includes('# 評価メモ') && !rendered.startsWith('\uFEFF'), 'Japanese UTF-8 memo rendering changed.');
      check(rendered === renderMemo(BASIC_MEMO, { created: '2026-01-15' }), 'Memo renderer is not byte deterministic.');
    },
  },
  {
    id: 'core.memo.english', suite: 'memo', run: () => {
      const document = { title: 'English memo', summary: 'Stable conclusion.' };
      check(memoDocumentSchema.safeParse(document).success, 'English memo failed schema validation.');
      check(renderMemo(document, { created: '2026-01-15' }).includes('# English memo'), 'English memo render failed.');
    },
  },
  {
    id: 'core.memo.mixed', suite: 'memo', run: () => {
      const document = { title: 'トヨタ DCF result', summary: '日本語 and English 123。' };
      check(renderMemo(document, { created: '2026-01-15' }).includes('日本語 and English 123。'), 'Mixed-language memo changed.');
    },
  },
  {
    id: 'core.memo.special', suite: 'memo', run: (root) => {
      const title = '成長/収益:*? 🚀 . ';
      const safe = sanitizeMemoFilenameTitle(title);
      check(!/[<>:"/\\|?*]/.test(safe), 'Unsafe filename character remained.');
      const path = resolveMemoFilePath(root, title, '2026-01-15');
      check(path.endsWith(buildMemoFilename(title, '2026-01-15')), 'Memo path and filename disagree.');
    },
  },
  {
    id: 'core.memo.duplicate', suite: 'memo', run: async (root) => {
      const area = join(root, 'memo-duplicate');
      const tool = createWriteMemoTool({ cwd: area });
      const input = { document: BASIC_MEMO, created: '2026-01-15' };
      await tool.invoke(input);
      const target = resolveMemoFilePath(area, BASIC_MEMO.title, '2026-01-15');
      const first = readFileSync(target, 'utf8');
      let rejected = false;
      try { await tool.invoke(input); } catch (error) { rejected = String(error).includes('already exists'); }
      check(rejected, 'Duplicate memo was not rejected.');
      check(readFileSync(target, 'utf8') === first, 'Duplicate memo changed the original.');
    },
  },
  {
    id: 'core.memo.changed-content', suite: 'memo', run: async (root) => {
      const gate = new OperationApprovalGate(async () => 'allow-once', new Set(), { cwd: root, now: new Date('2026-01-15T12:00:00Z') });
      await gate.authorize('write_memo', { document: BASIC_MEMO });
      expectThrow(() => gate.claim('write_memo', { document: { ...BASIC_MEMO, summary: 'changed' } }), 'not approved');
    },
  },
  {
    id: 'core.memo.changed-destination', suite: 'memo', run: async (root) => {
      const gate = new OperationApprovalGate(async () => 'allow-once', new Set(), { cwd: root, now: new Date('2026-01-15T12:00:00Z') });
      await gate.authorize('write_memo', { document: BASIC_MEMO });
      expectThrow(() => gate.claim('write_memo', { document: { ...BASIC_MEMO, title: 'other' } }), 'not approved');
    },
  },
  {
    id: 'core.memo.memory-isolation', suite: 'memo', run: async (root) => {
      const area = join(root, 'memo-memory-isolation');
      const prepared = prepareWriteMemoInput({ document: BASIC_MEMO }, '2026-01-15');
      await createWriteMemoTool({ cwd: area }).invoke(prepared);
      check(existsSync(resolveMemoFilePath(area, BASIC_MEMO.title, '2026-01-15')), 'Memo file was not created.');
      check((await new MemoryStore(join(area, '.dexter')).listMemoryFiles()).length === 0, 'Memo was promoted to memory.');
    },
  },
];

export async function runArchitectureBaseline(): Promise<ArchitectureBaselineResult> {
  const root = mkdtempSync(join(tmpdir(), 'dexter-phase7-eval-'));
  const results: BaselineCaseResult[] = [];
  try {
    for (const definition of CASES) {
      try {
        await definition.run(root);
        results.push({ id: definition.id, suite: definition.suite, passed: true, message: 'PASS' });
      } catch (error) {
        results.push({
          id: definition.id,
          suite: definition.suite,
          passed: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    safeRemoveTemp(root);
  }

  const passed = results.filter((result) => result.passed).length;
  return {
    result: passed === results.length ? 'PASS' : 'FAIL',
    excludedFromCrossModelScores: true,
    testCount: results.length,
    passed,
    failed: results.length - passed,
    cases: results,
  };
}