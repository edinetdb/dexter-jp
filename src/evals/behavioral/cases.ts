import type { EvalCase } from './types.js';

/** Data-only behavioral contracts. Runtime adapters and assertions live elsewhere. */
export const BEHAVIORAL_EVAL_CASES: readonly EvalCase[] = [
  // Skill activation
  { id: 'skill.dcf.explicit', suite: 'skill-activation', layer: 2, userInput: 'Run a DCF on Toyota using these assumptions.', scenario: { kind: 'route', route: 'dcf' } },
  { id: 'skill.dcf.implicit-negative', suite: 'skill-activation', layer: 2, userInput: 'Is Toyota undervalued?', scenario: { kind: 'route', route: 'none' } },
  { id: 'skill.x.explicit', suite: 'skill-activation', layer: 2, userInput: 'Search X for reactions to Toyota earnings.', scenario: { kind: 'route', route: 'x' } },
  { id: 'skill.x.implicit-negative', suite: 'skill-activation', layer: 2, userInput: 'What are investors saying?', scenario: { kind: 'route', route: 'none' } },
  { id: 'skill.memo.japanese-explicit', suite: 'skill-activation', layer: 2, userInput: 'これをメモにして', scenario: { kind: 'route', route: 'memo' } },
  { id: 'skill.memo.english-explicit', suite: 'skill-activation', layer: 2, userInput: 'Save this as a memo.', scenario: { kind: 'route', route: 'memo' } },
  { id: 'skill.memo.negative', suite: 'skill-activation', layer: 2, userInput: '要約してください。メモにはしないでください。', scenario: { kind: 'route', route: 'none' } },
  { id: 'skill.memory-vs-memo', suite: 'skill-activation', layer: 2, userInput: 'これを覚えておいて', scenario: { kind: 'route', route: 'memory' } },
  { id: 'skill.unavailable-capability', suite: 'skill-activation', layer: 2, userInput: 'Search X for Toyota.', scenario: { kind: 'route', route: 'x', xAvailable: false } },

  // DCF
  { id: 'dcf.valid', suite: 'dcf', layer: 4, userInput: 'Run a DCF using the supplied forecasts, WACC, growth, net debt, and shares.', scenario: { kind: 'dcf', variant: 'valid' } },
  { id: 'dcf.wacc-equals-growth', suite: 'dcf', layer: 4, userInput: 'Run a DCF with WACC 2% and terminal growth 2%.', scenario: { kind: 'dcf', variant: 'equal-rates' } },
  { id: 'dcf.wacc-below-growth', suite: 'dcf', layer: 4, userInput: 'Run a DCF with WACC 1% and terminal growth 2%.', scenario: { kind: 'dcf', variant: 'lower-wacc' } },
  { id: 'dcf.negative-fcf', suite: 'dcf', layer: 4, userInput: 'Run a DCF that includes a negative first-year FCF.', scenario: { kind: 'dcf', variant: 'negative-fcf' } },
  { id: 'dcf.net-cash', suite: 'dcf', layer: 4, userInput: 'Run a DCF with net cash represented as negative net debt.', scenario: { kind: 'dcf', variant: 'net-cash' } },
  { id: 'dcf.sensitivity', suite: 'dcf', layer: 4, userInput: 'Run a DCF and include the sensitivity matrix.', scenario: { kind: 'dcf', variant: 'sensitivity' } },
  { id: 'dcf.not-requested', suite: 'dcf', layer: 2, userInput: 'Calculate Toyota\'s valuation.', scenario: { kind: 'route', route: 'none' } },

  // Approval — unavailable SDK tools are evaluated in the architecture baseline;
  // memo approval parity is covered by the memo end-to-end cases on both runtimes.
  { id: 'approval.read', suite: 'approval', layer: 3, userInput: 'このファイルを読んで', scenario: { kind: 'approval', variant: 'read' }, applicableRuntimes: ['langchain'] },
  { id: 'approval.local-mutation', suite: 'approval', layer: 3, userInput: 'このファイルを書き換えて', scenario: { kind: 'approval', variant: 'local-mutation' }, applicableRuntimes: ['langchain'] },
  { id: 'approval.external-mutation', suite: 'approval', layer: 3, userInput: 'heartbeatを更新して', scenario: { kind: 'approval', variant: 'external-mutation' }, applicableRuntimes: ['langchain'] },
  { id: 'approval.destructive', suite: 'approval', layer: 3, userInput: 'このcron jobを削除して', scenario: { kind: 'approval', variant: 'destructive-mutation' }, applicableRuntimes: ['langchain'] },
  { id: 'approval.same-tool-different-action', suite: 'approval', layer: 3, userInput: 'cronを確認してから削除して', scenario: { kind: 'approval', variant: 'same-tool-different-action' }, applicableRuntimes: ['langchain'] },
  { id: 'approval.changed-target', suite: 'approval', layer: 3, userInput: '承認済みtargetだけを書き換えて', scenario: { kind: 'approval', variant: 'changed-target' }, applicableRuntimes: ['langchain'] },
  { id: 'approval.changed-args', suite: 'approval', layer: 3, userInput: '承認済み内容だけを書き込んで', scenario: { kind: 'approval', variant: 'changed-args' }, applicableRuntimes: ['langchain'] },
  { id: 'approval.retry-identical', suite: 'approval', layer: 3, userInput: '同じoperationを再試行して', scenario: { kind: 'approval', variant: 'retry-identical' }, applicableRuntimes: ['langchain'] },
  { id: 'approval.retry-changed', suite: 'approval', layer: 3, userInput: '変更されたoperationを再試行して', scenario: { kind: 'approval', variant: 'retry-changed' }, applicableRuntimes: ['langchain'] },
  { id: 'approval.unknown-operation', suite: 'approval', layer: 3, userInput: '未知のmutationを実行して', scenario: { kind: 'approval', variant: 'unknown-operation' }, applicableRuntimes: ['langchain'] },

  // Privacy
  { id: 'privacy.conversation-only', suite: 'privacy', layer: 4, userInput: 'Ordinary conversation only.', scenario: { kind: 'privacy', variant: 'conversation' } },
  { id: 'privacy.scratchpad', suite: 'privacy', layer: 4, userInput: 'A run contains transient scratchpad state.', scenario: { kind: 'privacy', variant: 'scratchpad' } },
  { id: 'privacy.tool-result', suite: 'privacy', layer: 4, userInput: 'A run contains intermediate tool output.', scenario: { kind: 'privacy', variant: 'tool-result' } },
  { id: 'privacy.compaction', suite: 'privacy', layer: 4, userInput: 'Compact the current conversation state.', scenario: { kind: 'privacy', variant: 'compaction' } },
  { id: 'privacy.explicit-memory', suite: 'privacy', layer: 4, userInput: 'これを覚えておいて', scenario: { kind: 'privacy', variant: 'explicit-memory' } },
  { id: 'privacy.memo-is-not-memory', suite: 'privacy', layer: 4, userInput: 'この内容をメモとして保存して', scenario: { kind: 'privacy', variant: 'memo' } },
  { id: 'privacy.restart', suite: 'privacy', layer: 4, userInput: 'Restart after transient and explicitly persisted state.', scenario: { kind: 'privacy', variant: 'restart' } },

  // Memo
  { id: 'memo.japanese', suite: 'memo', layer: 4, userInput: '日本語でこの分析をメモにして', scenario: { kind: 'memo', variant: 'japanese' } },
  { id: 'memo.english', suite: 'memo', layer: 4, userInput: 'Write this analysis as a memo.', scenario: { kind: 'memo', variant: 'english' } },
  { id: 'memo.mixed-language', suite: 'memo', layer: 4, userInput: 'このDCF resultをmemoとして保存して', scenario: { kind: 'memo', variant: 'mixed' } },
  { id: 'memo.special-characters', suite: 'memo', layer: 4, userInput: '「成長/収益:*? 🚀」というタイトルでメモを作って', scenario: { kind: 'memo', variant: 'special' } },
  { id: 'memo.duplicate', suite: 'memo', layer: 4, userInput: '同じ内容をメモとして保存して', scenario: { kind: 'memo', variant: 'duplicate' } },
  { id: 'memo.changed-content-after-approval', suite: 'memo', layer: 4, userInput: '承認した内容だけでメモを作って', scenario: { kind: 'memo', variant: 'changed-content' } },
  { id: 'memo.changed-destination-after-approval', suite: 'memo', layer: 4, userInput: '承認した保存先だけにメモを作って', scenario: { kind: 'memo', variant: 'changed-destination' } },
  { id: 'memo.memory-isolation', suite: 'memo', layer: 4, userInput: 'この内容をメモにして', scenario: { kind: 'memo', variant: 'memory-isolation' } },

  // Adversarial and Japanese wording coverage
  { id: 'adversarial.memo-negated-en', suite: 'adversarial-routing', layer: 2, userInput: "Don't create a memo. Just explain what a memo would contain.", scenario: { kind: 'route', route: 'none' } },
  { id: 'adversarial.memo-quoted-en', suite: 'adversarial-routing', layer: 2, userInput: 'The text says "save this as a memo", but I only want you to summarize it.', scenario: { kind: 'route', route: 'none' } },
  { id: 'adversarial.remember-translation', suite: 'adversarial-routing', layer: 2, userInput: 'Show me how to say "remember this" in Japanese.', scenario: { kind: 'route', route: 'none' } },
  { id: 'adversarial.x-implicit', suite: 'adversarial-routing', layer: 2, userInput: 'Search investor sentiment.', scenario: { kind: 'route', route: 'none' } },
  { id: 'adversarial.dcf-implicit', suite: 'adversarial-routing', layer: 2, userInput: "Calculate Toyota's valuation.", scenario: { kind: 'route', route: 'none' } },
  { id: 'adversarial.ja-colloquial-memo', suite: 'adversarial-routing', layer: 2, userInput: 'これメモっといて', scenario: { kind: 'route', route: 'none' } },
  { id: 'adversarial.ja-colloquial-memory', suite: 'adversarial-routing', layer: 2, userInput: 'これ覚えといて', scenario: { kind: 'route', route: 'memory' } },
  { id: 'adversarial.ja-polite-memo', suite: 'adversarial-routing', layer: 2, userInput: 'この内容をメモとして保存してください。', scenario: { kind: 'route', route: 'memo' } },
  { id: 'adversarial.ja-short-memo', suite: 'adversarial-routing', layer: 2, userInput: 'メモにして', scenario: { kind: 'route', route: 'memo' } },
  { id: 'adversarial.ja-negated-memo', suite: 'adversarial-routing', layer: 2, userInput: 'メモにはしないで、説明だけして。', scenario: { kind: 'route', route: 'none' } },
  { id: 'adversarial.ja-quoted-memo', suite: 'adversarial-routing', layer: 2, userInput: '「メモにして」という文を英訳して。', scenario: { kind: 'route', route: 'none' } },
  { id: 'adversarial.ambiguous-save', suite: 'adversarial-routing', layer: 2, userInput: 'この内容を保存して', scenario: { kind: 'route', route: 'none' } },
] as const;