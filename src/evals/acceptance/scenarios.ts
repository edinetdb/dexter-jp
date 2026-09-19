import type { CalculateDcfInput } from '../../tools/finance/calculate-dcf.js';
import type { MemoDocument } from '../../memo/document.js';
import type {
  AcceptanceScenario,
  FileDiffExpectation,
  TurnExpectation,
} from './types.js';

const DCF_INPUT: CalculateDcfInput = {
  forecastFreeCashFlows: [
    { period: '2026', value: 120 },
    { period: '2027', value: 135 },
    { period: '2028', value: 150 },
  ],
  wacc: 0.08,
  terminalGrowthRate: 0.02,
  netDebt: 40,
  dilutedSharesOutstanding: 100_000_000,
  unit: 'JPY_billion',
};

const INVALID_DCF_INPUT: CalculateDcfInput = {
  ...DCF_INPUT,
  wacc: 0.02,
  terminalGrowthRate: 0.02,
};

const NO_FILE_DIFF: FileDiffExpectation = { created: [], modified: [], deleted: [] };
const HEAVY_TOOLS = [
  'read_filings',
  'get_financials',
  'web_search',
  'read_filings',
  'get_financials',
  'web_search',
  'read_filings',
  'get_financials',
];

function expectTurn(
  calledTools: string[],
  finalMarkers: string[],
  options: Partial<TurnExpectation> = {},
): TurnExpectation {
  return {
    skills: [],
    calledTools,
    finalMarkers,
    ...options,
  };
}

function memo(title: string, summary: string, tags?: string[]): MemoDocument {
  return {
    title,
    summary,
    keyPoints: ['確認済みの結論だけを記録する', '一時的なツール出力は含めない'],
    ...(tags ? { tags } : {}),
  };
}

export const ACCEPTANCE_SCENARIOS: readonly AcceptanceScenario[] = [
  {
    id: 'A1-dcf-japanese-explicit',
    category: 'dcf',
    description: '日本語の明示的DCF依頼でSkillから計算器へ進む。',
    turns: [{
      input: 'この前提でDCF評価して。FCFは120、135、150億円、WACC 8%、永久成長率2%、純有利子負債40億円、希薄化後株式数1億株です。',
      action: { kind: 'dcf', input: DCF_INPUT },
      expected: expectTurn(['skill', 'calculate_dcf'], ['DCF_RESULT', 'WACC=0.08', 'growth=0.02', 'intrinsic='], {
        skills: ['dcf-valuation'], approval: { count: 0 }, exposedToolsInclude: ['calculate_dcf', 'skill'],
      }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: ['dcf-calculator-used'] },
  },
  {
    id: 'A2-dcf-english-explicit',
    category: 'dcf',
    description: 'English explicit DCF request follows the same deterministic calculator path.',
    turns: [{
      input: 'Run a DCF using FCF 120, 135, 150 JPY bn, WACC 8%, terminal growth 2%, net debt 40 JPY bn, and 100m diluted shares.',
      action: { kind: 'dcf', input: DCF_INPUT },
      expected: expectTurn(['skill', 'calculate_dcf'], ['DCF_RESULT', 'WACC=0.08', 'growth=0.02'], {
        skills: ['dcf-valuation'], approval: { count: 0 }, exposedToolsInclude: ['calculate_dcf', 'skill'],
      }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: ['dcf-calculator-used'] },
  },
  {
    id: 'A3-dcf-invalid-rates',
    category: 'dcf',
    description: 'WACCが成長率以下なら推測補正せず入力を拒否する。',
    turns: [{
      input: 'WACC 2%、永久成長率2%のままDCFを計算して。他の前提は前と同じ。',
      action: { kind: 'dcf', input: INVALID_DCF_INPUT },
      expected: expectTurn(['skill', 'calculate_dcf'], ['DCF_INPUT_REJECTED'], {
        skills: ['dcf-valuation'], approval: { count: 0 }, forbiddenTools: [], forbiddenFinalMarkers: ['DCF_RESULT', 'intrinsic='],
      }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: [] },
  },
  {
    id: 'A4-dcf-multiturn-activation',
    category: 'dcf',
    description: '割安性の一般質問では起動せず、次ターンの明示依頼で起動する。',
    turns: [
      {
        input: 'この会社は割安そう？ まず一般的な見方だけ教えて。',
        action: { kind: 'none', marker: 'GENERAL_VALUATION_GUIDANCE' },
        expected: expectTurn([], ['GENERAL_VALUATION_GUIDANCE'], { forbiddenTools: ['calculate_dcf'] }),
      },
      {
        input: 'では、今出した前提を使ってDCFでも見て。WACC 8%、永久成長率2%で。',
        action: { kind: 'dcf', input: DCF_INPUT },
        expected: expectTurn(['skill', 'calculate_dcf'], ['DCF_RESULT'], { skills: ['dcf-valuation'], approval: { count: 0 } }),
      },
    ],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: ['dcf-calculator-used'] },
  },
  {
    id: 'B1-x-multiturn-explicit',
    category: 'research-x',
    description: '一般的なセンチメント質問の後、明示的X指定でのみX検索する。',
    turns: [
      {
        input: '市場ではこの決算をどう受け止めていますか？',
        action: { kind: 'none', marker: 'GENERAL_SENTIMENT_RESPONSE' },
        expected: expectTurn([], ['GENERAL_SENTIMENT_RESPONSE'], { forbiddenTools: ['x_search'] }),
      },
      {
        input: 'X上の直近24時間の反応に限定して調べて。',
        action: { kind: 'x-research', query: '直近24時間 決算 反応' },
        expected: expectTurn(['skill', 'x_search'], ['X_RESEARCH_COMPLETE'], { skills: ['x-research'], approval: { count: 0 } }),
      },
    ],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: [] },
  },
  {
    id: 'B2-x-generic-sentiment',
    category: 'research-x',
    description: '一般的なセンチメント質問はX検索を起動しない。',
    turns: [{
      input: '最近の投資家センチメントをざっくり説明して。',
      action: { kind: 'none', marker: 'GENERAL_SENTIMENT_RESPONSE' },
      expected: expectTurn([], ['GENERAL_SENTIMENT_RESPONSE'], { forbiddenTools: ['x_search'] }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: [] },
  },
  {
    id: 'B3-x-quoted-instruction',
    category: 'research-x',
    description: '引用されたX検索指示の説明では検索しない。',
    turns: [{
      input: 'ユーザーが「Xで調べて」と言った場合の処理を説明してください。実際には検索しないでください。',
      action: { kind: 'none', marker: 'EXPLANATION_ONLY' },
      expected: expectTurn([], ['EXPLANATION_ONLY'], { forbiddenTools: ['x_search'] }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: [] },
  },
  {
    id: 'C1-memo-japanese-multiturn',
    category: 'memo',
    description: '内容整理の次ターンで日本語memoを明示作成する。',
    turns: [
      {
        input: '今日の会議の要点を整理して。決定事項は段階リリースです。',
        action: { kind: 'none', marker: 'CONTENT_ORGANIZED' },
        expected: expectTurn([], ['CONTENT_ORGANIZED'], { exposedToolsExclude: ['write_memo'], discoveredSkillsExclude: ['write-memo'], forbiddenTools: ['write_memo'] }),
      },
      {
        input: 'その内容を日本語のメモにして保存して。',
        action: { kind: 'memo', document: memo('日本語の会議メモ', '段階リリースを採用する。', ['会議', '決定']) },
        approval: { decision: 'allow-once' },
        expected: expectTurn(['skill', 'write_memo'], ['MEMO_CREATED'], {
          skills: ['write-memo'], exposedToolsInclude: ['write_memo'], approval: { count: 1, risks: ['local_mutation'], decisions: ['allow-once'] },
        }),
      },
    ],
    expectedOutcome: {
      files: { created: ['.dexter/memos/20260115-日本語の会議メモ.md'], modified: [], deleted: [] },
      memoryChanged: false,
      memoChanged: true,
      criticalChecks: ['approval-bound', 'memo-memory-separated'],
    },
  },
  {
    id: 'C2-memo-english',
    category: 'memo',
    description: 'English memo request writes deterministic Markdown.',
    turns: [{
      input: 'Write this as a memo and save it: the project will ship in two stages.',
      action: { kind: 'memo', document: memo('English project memo', 'The project will ship in two stages.', ['project']) },
      approval: { decision: 'allow-once' },
      expected: expectTurn(['skill', 'write_memo'], ['MEMO_CREATED'], {
        skills: ['write-memo'], exposedToolsInclude: ['write_memo'], approval: { count: 1, risks: ['local_mutation'], decisions: ['allow-once'] },
      }),
    }],
    expectedOutcome: {
      files: { created: ['.dexter/memos/20260115-English-project-memo.md'], modified: [], deleted: [] },
      memoryChanged: false, memoChanged: true, criticalChecks: ['approval-bound', 'memo-memory-separated'],
    },
  },
  {
    id: 'C3-memo-mixed-language',
    category: 'memo',
    description: '日本語・English・emoji混在memoをUTF-8で保存する。',
    turns: [{
      input: 'このlaunch planをmemoとして保存して。タイトルは「日英 Mixed メモ 🚀」。',
      action: { kind: 'memo', document: memo('日英 Mixed メモ 🚀', 'Launchは9月。品質gateを先に確認する。', ['launch', '日本語']) },
      approval: { decision: 'allow-once' },
      expected: expectTurn(['skill', 'write_memo'], ['MEMO_CREATED'], {
        skills: ['write-memo'], approval: { count: 1, risks: ['local_mutation'], decisions: ['allow-once'] },
      }),
    }],
    expectedOutcome: {
      files: { created: ['.dexter/memos/20260115-日英-Mixed-メモ-🚀.md'], modified: [], deleted: [] },
      memoryChanged: false, memoChanged: true, criticalChecks: ['approval-bound', 'memo-memory-separated'],
    },
  },
  {
    id: 'C4-memo-duplicate-preserved',
    category: 'memo',
    description: '同名・同日の二回目は既存memoを静かに上書きしない。',
    turns: [
      {
        input: 'この内容を「重複保護テスト」というメモにして保存して。',
        action: { kind: 'memo', document: memo('重複保護テスト', '最初の確定内容。') },
        approval: { decision: 'allow-once' },
        expected: expectTurn(['skill', 'write_memo'], ['MEMO_CREATED'], { skills: ['write-memo'], approval: { count: 1 } }),
      },
      {
        input: '同じタイトルでもう一度メモとして保存して。',
        action: { kind: 'memo', document: memo('重複保護テスト', '二回目の異なる内容。') },
        approval: { decision: 'allow-once' },
        expected: expectTurn(['skill', 'write_memo'], ['MEMO_DUPLICATE_REJECTED'], { skills: ['write-memo'], approval: { count: 1 } }),
      },
    ],
    expectedOutcome: {
      files: { created: ['.dexter/memos/20260115-重複保護テスト.md'], modified: [], deleted: [] },
      memoryChanged: false, memoChanged: true, criticalChecks: ['approval-bound', 'memo-memory-separated', 'duplicate-preserved'],
    },
  },
  {
    id: 'C5-memo-negative-intent',
    category: 'memo',
    description: '明示的なmemo否定ではSkillもwrite toolも起動しない。',
    turns: [{
      input: 'メモにはしないで。内容だけ整理して。',
      action: { kind: 'none', marker: 'CONTENT_ONLY_NO_MEMO' },
      expected: expectTurn([], ['CONTENT_ONLY_NO_MEMO'], {
        exposedToolsExclude: ['write_memo'], discoveredSkillsExclude: ['write-memo'], forbiddenTools: ['skill', 'write_memo'], forbiddenFinalMarkers: ['MEMO_CREATED'],
      }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: ['memo-memory-separated'] },
  },
  {
    id: 'D1-memory-explicit',
    category: 'memory',
    description: '明示的なremember依頼はdurable memoryだけを更新する。',
    turns: [{
      input: '今後の会話のために、私は短い箇条書きを好むと覚えておいて。',
      action: { kind: 'memory-append', content: '- User prefers concise bullet lists.\n' },
      approval: { decision: 'allow-once' },
      expected: expectTurn(['memory_update'], ['MEMORY_UPDATED'], {
        exposedToolsExclude: ['write_memo'], discoveredSkillsExclude: ['write-memo'], approval: { count: 1, risks: ['local_mutation'], decisions: ['allow-once'] }, forbiddenTools: ['write_memo'],
      }),
    }],
    expectedOutcome: {
      files: { created: ['.dexter/memory/MEMORY.md'], modified: [], deleted: [] },
      memoryChanged: true, memoChanged: false, criticalChecks: ['approval-bound', 'memory-memo-separated'],
    },
  },
  {
    id: 'D2-memo-only-no-memory',
    category: 'memory',
    description: 'memo作成はdurable memoryを暗黙更新しない。',
    turns: [{
      input: 'これはメモとして保存して。記憶には入れないで。',
      action: { kind: 'memo', document: memo('独立したメモ', 'memo storageとdurable memoryは別である。') },
      approval: { decision: 'allow-once' },
      expected: expectTurn(['skill', 'write_memo'], ['MEMO_CREATED'], {
        skills: ['write-memo'], approval: { count: 1 }, forbiddenTools: ['memory_update'],
      }),
    }],
    expectedOutcome: {
      files: { created: ['.dexter/memos/20260115-独立したメモ.md'], modified: [], deleted: [] },
      memoryChanged: false, memoChanged: true, criticalChecks: ['approval-bound', 'memo-memory-separated'],
    },
  },
  {
    id: 'D3-conversation-not-memory',
    category: 'memory',
    description: '通常会話はmemory updateを起動しない。',
    turns: [{
      input: '今日は少し疲れました。軽い説明でお願いします。',
      action: { kind: 'none', marker: 'CONVERSATION_RESPONSE' },
      expected: expectTurn([], ['CONVERSATION_RESPONSE'], { forbiddenTools: ['memory_update', 'write_memo'] }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: ['transient-not-durable'] },
  },
  {
    id: 'E1-approval-read-only',
    category: 'approval',
    description: 'read-only操作はapprovalなしで実行する。',
    initialFiles: { 'notes.txt': 'alpha\nbeta\n' },
    turns: [{
      input: 'notes.txtを読んで内容を確認して。',
      action: { kind: 'read-file', path: 'notes.txt' },
      expected: expectTurn(['read_file'], ['READ_COMPLETE'], { approval: { count: 0 } }),
    }],
    expectedOutcome: { files: { ...NO_FILE_DIFF, unchanged: ['notes.txt'] }, memoryChanged: false, memoChanged: false, criticalChecks: [] },
  },
  {
    id: 'E2-approval-local-mutation',
    category: 'approval',
    description: 'read後のlocal editはexact operation approvalを通る。',
    initialFiles: { 'notes.txt': 'status: draft\n' },
    turns: [
      {
        input: 'notes.txtの現在の状態を確認して。',
        action: { kind: 'read-file', path: 'notes.txt' },
        expected: expectTurn(['read_file'], ['READ_COMPLETE'], { approval: { count: 0 } }),
      },
      {
        input: 'statusをfinalに変更して。',
        action: { kind: 'edit-file', path: 'notes.txt', oldText: 'status: draft', newText: 'status: final' },
        approval: { decision: 'allow-once' },
        expected: expectTurn(['edit_file'], ['EDIT_COMPLETE'], { approval: { count: 1, risks: ['local_mutation'], decisions: ['allow-once'] } }),
      },
    ],
    expectedOutcome: {
      files: { created: [], modified: ['notes.txt'], deleted: [] },
      memoryChanged: false, memoChanged: false, criticalChecks: ['approval-bound'],
    },
  },
  {
    id: 'E3-approval-destructive-denied',
    category: 'approval',
    description: 'destructive operationはapprovalを要求し、拒否時に実行しない。',
    turns: [{
      input: '古いcron jobを削除して。',
      action: { kind: 'destructive-denied', jobId: 'job-old-001' },
      approval: { decision: 'deny' },
      expected: expectTurn(['cron'], ['OPERATION_DENIED'], { approval: { count: 1, risks: ['destructive'], decisions: ['deny'] }, forbiddenFinalMarkers: ['DESTRUCTIVE_OPERATION_EXECUTED'] }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: ['approval-bound', 'destructive-blocked'] },
  },
  {
    id: 'E4-approval-target-substitution',
    category: 'approval',
    description: '承認後のtarget差替えを拒否する。',
    initialFiles: { 'approved.txt': 'old\n', 'other.txt': 'old\n' },
    turns: [{
      input: 'approved.txtだけを更新して。',
      action: { kind: 'target-substitution', approvedPath: 'approved.txt', candidatePath: 'other.txt', oldText: 'old', newText: 'new' },
      approval: { decision: 'allow-once' },
      expected: expectTurn(['edit_file'], ['TARGET_SUBSTITUTION_REJECTED'], { approval: { count: 1, risks: ['local_mutation'], decisions: ['allow-once'] }, forbiddenFinalMarkers: ['TARGET_SUBSTITUTION_EXECUTED'] }),
    }],
    expectedOutcome: {
      files: { ...NO_FILE_DIFF, unchanged: ['approved.txt', 'other.txt'] },
      memoryChanged: false, memoChanged: false, criticalChecks: ['target-substitution-rejected'],
    },
  },
  {
    id: 'E5-approval-argument-mutation',
    category: 'approval',
    description: '承認後のcontent変更を拒否する。',
    turns: [{
      input: 'approved contentでresult.txtを作成して。',
      action: { kind: 'argument-mutation', path: 'result.txt', approvedContent: 'approved content\n', candidateContent: 'changed after approval\n' },
      approval: { decision: 'allow-once' },
      expected: expectTurn(['write_file'], ['ARGUMENT_MUTATION_REJECTED'], { approval: { count: 1, risks: ['destructive'], decisions: ['allow-once'] }, forbiddenFinalMarkers: ['ARGUMENT_MUTATION_EXECUTED'] }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: ['argument-mutation-rejected'] },
  },
  {
    id: 'E6-approval-exact-retry',
    category: 'approval',
    description: 'allow-session後の同一exact operation retryは再promptしない。',
    turns: [{
      input: '同じ確定内容を二回送る再試行を許可して。',
      action: { kind: 'exact-retry', path: 'retry.txt', content: 'stable payload\n' },
      approval: { decision: 'allow-session' },
      expected: expectTurn(['write_file', 'write_file'], ['EXACT_RETRY_COMPLETE'], { approval: { count: 1, risks: ['destructive'], decisions: ['allow-session'] } }),
    }],
    expectedOutcome: {
      files: { created: ['retry.txt'], modified: [], deleted: [] },
      memoryChanged: false, memoChanged: false, criticalChecks: ['approval-bound'],
    },
  },
  {
    id: 'F1-privacy-tool-heavy-transient',
    category: 'privacy',
    description: '複数tool resultはtransient scratchpadだけに保持する。',
    turns: [{
      input: '複数ソースを横断して調査し、ここで要点だけ説明して。保存は不要です。',
      action: { kind: 'tool-heavy', count: 8 },
      expected: expectTurn(HEAVY_TOOLS, ['TOOL_HEAVY_COMPLETE'], { approval: { count: 0 } }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: ['transient-not-durable', 'reasoning-not-exposed'] },
  },
  {
    id: 'F2-privacy-compaction-context',
    category: 'privacy',
    description: 'compactionは必要文脈を保ち内部推論を露出・永続化しない。',
    turns: [
      {
        input: 'Alpha案件を調査して。重要な結論は段階導入です。',
        action: { kind: 'tool-heavy', count: 8 },
        expected: expectTurn(HEAVY_TOOLS, ['TOOL_HEAVY_COMPLETE'], { approval: { count: 0 } }),
      },
      {
        input: '文脈を短縮して、そのまま作業を続けられる状態にして。',
        action: { kind: 'compaction' },
        expected: expectTurn([], ['COMPACTION_CONTEXT_PRESERVED']),
      },
    ],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: ['transient-not-durable', 'reasoning-not-exposed'] },
  },
  {
    id: 'F3-privacy-restart-durable-only',
    category: 'privacy',
    description: 'restart後は明示保存memoryだけを復元しscratchpadは復元しない。',
    turns: [
      {
        input: '今後も使う設定として、回答は結論を先にすると覚えておいて。',
        action: { kind: 'memory-append', content: '- Put conclusions first in future answers.\n' },
        approval: { decision: 'allow-once' },
        expected: expectTurn(['memory_update'], ['MEMORY_UPDATED'], { approval: { count: 1 } }),
      },
      {
        input: 'ランタイムを再起動した後の状態を確認して。',
        action: { kind: 'restart' },
        expected: expectTurn([], ['RESTART_DURABLE_ONLY']),
      },
    ],
    expectedOutcome: {
      files: { created: ['.dexter/memory/MEMORY.md'], modified: [], deleted: [] },
      memoryChanged: true, memoChanged: false, criticalChecks: ['transient-not-durable', 'memory-memo-separated'],
    },
  },
  {
    id: 'F4-privacy-curated-memo-after-tools',
    category: 'privacy',
    description: '複雑なtool run後のmemoにはcurated conclusionだけを書く。',
    turns: [
      {
        input: '複数の資料を調べて候補を比較して。',
        action: { kind: 'tool-heavy', count: 8 },
        expected: expectTurn(HEAVY_TOOLS, ['TOOL_HEAVY_COMPLETE'], { approval: { count: 0 } }),
      },
      {
        input: '確定した結論だけをメモにして保存して。途中の候補や内部メモは入れないで。',
        action: { kind: 'memo', document: memo('調査の確定結論', '採用案は段階導入とする。', ['調査']) },
        approval: { decision: 'allow-once' },
        expected: expectTurn(['skill', 'write_memo'], ['MEMO_CREATED'], { skills: ['write-memo'], approval: { count: 1 } }),
      },
    ],
    expectedOutcome: {
      files: { created: ['.dexter/memos/20260115-調査の確定結論.md'], modified: [], deleted: [] },
      memoryChanged: false, memoChanged: true, criticalChecks: ['transient-not-durable', 'reasoning-not-exposed', 'memo-memory-separated'],
    },
  },
  {
    id: 'G1-adversarial-quoted-memo-translation',
    category: 'adversarial',
    description: 'memo命令の引用翻訳ではmemoを作らない。',
    turns: [{
      input: '「これをメモにして」を英訳して。実際のメモは作らないで。',
      action: { kind: 'none', marker: 'TRANSLATION_ONLY' },
      expected: expectTurn([], ['TRANSLATION_ONLY'], { exposedToolsExclude: ['write_memo'], discoveredSkillsExclude: ['write-memo'], forbiddenTools: ['write_memo'] }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: ['memo-memory-separated'] },
  },
  {
    id: 'G2-adversarial-explain-remember',
    category: 'adversarial',
    description: 'remember処理の説明ではmemoryを更新しない。',
    turns: [{
      input: '「覚えておいて」という依頼をシステムがどう処理するか説明して。実際には記憶しないで。',
      action: { kind: 'none', marker: 'EXPLANATION_ONLY' },
      expected: expectTurn([], ['EXPLANATION_ONLY'], { forbiddenTools: ['memory_update'] }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: ['transient-not-durable'] },
  },
  {
    id: 'G3-adversarial-explain-dcf',
    category: 'adversarial',
    description: 'DCFの概念説明では計算器を使わない。',
    turns: [{
      input: 'DCFを使わずに、DCFとは何かだけ説明して。',
      action: { kind: 'none', marker: 'DCF_EXPLANATION_ONLY' },
      expected: expectTurn([], ['DCF_EXPLANATION_ONLY'], { forbiddenTools: ['calculate_dcf'] }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: [] },
  },
  {
    id: 'G4-adversarial-no-x',
    category: 'adversarial',
    description: 'Xを使わない明示指示を尊重する。',
    turns: [{
      input: 'Xは使わないで、一般論として投資家心理を説明して。',
      action: { kind: 'none', marker: 'NO_X_RESPECTED' },
      expected: expectTurn([], ['NO_X_RESPECTED'], { forbiddenTools: ['x_search'] }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: [] },
  },
  {
    id: 'G5-adversarial-explain-delete',
    category: 'adversarial',
    description: 'delete手順の説明では削除operationを実行しない。',
    turns: [{
      input: 'ファイルを削除する手順を説明して。実際の削除はしないで。',
      action: { kind: 'none', marker: 'DELETE_EXPLANATION_ONLY' },
      expected: expectTurn([], ['DELETE_EXPLANATION_ONLY'], { forbiddenTools: ['cron', 'write_file', 'edit_file'] }),
    }],
    expectedOutcome: { files: NO_FILE_DIFF, memoryChanged: false, memoChanged: false, criticalChecks: ['destructive-blocked'] },
  },
];