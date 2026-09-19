import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../memory/store.js';
import {
  assertSameOperation,
  createOperationApprovalRequest,
  decideOperationApproval,
  formatOperationForApproval,
  isKnownToolOperation,
  normalizeToolOperation,
  OperationApprovalGate,
} from './operation-policy.js';
import { getToolRegistry } from '../tools/registry.js';

let testRoot = '';

function removeTestRoot(path: string): void {
  const resolvedPath = resolve(path);
  const resolvedTemp = resolve(tmpdir());
  if (!resolvedPath.startsWith(resolvedTemp + sep)) {
    throw new Error('Refusing to remove a path outside the test temp directory.');
  }
  rmSync(resolvedPath, { recursive: true, force: true });
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'dexter-operation-policy-'));
});

afterEach(() => {
  if (testRoot && existsSync(testRoot)) removeTestRoot(testRoot);
  testRoot = '';
});

describe('operation risk classification', () => {
  test('read-only operation does not require approval', () => {
    const operation = normalizeToolOperation(
      'read_file',
      { path: 'report.md' },
      { cwd: testRoot },
    );

    expect(operation.kind).toBe('file.read');
    expect(operation.risk).toBe('read_only');
    expect(decideOperationApproval(operation).requirement).toBe('none');
  });

  test('local mutation requires approval', () => {
    const operation = normalizeToolOperation(
      'edit_file',
      { path: 'report.md', old_text: 'old', new_text: 'new' },
      { cwd: testRoot },
    );

    expect(operation.risk).toBe('local_mutation');
    expect(decideOperationApproval(operation).requirement).toBe('user_approval');
  });

  test('create-or-overwrite stays deterministically destructive across filesystem state', () => {
    const args = { path: 'artifact.md', content: 'content' };
    const before = normalizeToolOperation('write_file', args, { cwd: testRoot });
    writeFileSync(join(testRoot, 'artifact.md'), 'existing', 'utf8');
    const after = normalizeToolOperation('write_file', args, { cwd: testRoot });

    expect(before.kind).toBe('file.write');
    expect(before.risk).toBe('destructive');
    expect(before.fingerprint).toBe(after.fingerprint);
  });
  test('memo creation is normalized to a deterministic approved target and runtime date', () => {
    const operation = normalizeToolOperation('write_memo', {
      created: '1999-01-01',
      document: {
        title: '日本語 / メモ',
        summary: '確定内容',
      },
    }, {
      cwd: testRoot,
      now: new Date('2026-09-19T12:00:00+09:00'),
    });

    expect(operation.kind).toBe('memo.create');
    expect(operation.action).toBe('create');
    expect(operation.risk).toBe('local_mutation');
    expect(operation.target).toBe(join(
      testRoot,
      '.dexter',
      'memos',
      '20260919-日本語-メモ.md',
    ));
    expect(operation.arguments.created).toBe('2026-09-19');
    expect(decideOperationApproval(operation).requirement).toBe('user_approval');
    expect(formatOperationForApproval(operation).join('\n')).toContain('Title: 日本語 / メモ');
  });

  test('external mutation requires approval', () => {
    const operation = normalizeToolOperation('browser', {
      action: 'act',
      request: { kind: 'click', ref: 'e7' },
    });

    expect(operation.kind).toBe('browser.act.click');
    expect(operation.risk).toBe('external_mutation');
    expect(decideOperationApproval(operation).requirement).toBe('user_approval');
  });

  test('destructive operation requires approval', () => {
    const operation = normalizeToolOperation('cron', {
      action: 'remove',
      jobId: 'job-1',
    });

    expect(operation.kind).toBe('cron.delete');
    expect(operation.risk).toBe('destructive');
    expect(decideOperationApproval(operation).requirement).toBe('user_approval');
  });

  test('the same tool distinguishes read from delete', () => {
    const read = normalizeToolOperation('cron', { action: 'list' });
    const remove = normalizeToolOperation('cron', {
      action: 'remove',
      jobId: 'job-1',
    });

    expect(decideOperationApproval(read).requirement).toBe('none');
    expect(decideOperationApproval(remove).requirement).toBe('user_approval');
    expect(read.fingerprint).not.toBe(remove.fingerprint);
  });

  test('the same tool distinguishes read from update', () => {
    const read = normalizeToolOperation('heartbeat', { action: 'view' });
    const update = normalizeToolOperation('heartbeat', {
      action: 'update',
      content: '- watch 7203',
    });

    expect(read.risk).toBe('read_only');
    expect(update.risk).toBe('external_mutation');
    expect(read.fingerprint).not.toBe(update.fingerprint);
  });

  test('identical normalized operations produce identical decisions and fingerprints', () => {
    const first = normalizeToolOperation(
      'edit_file',
      { new_text: 'new', path: 'report.md', old_text: 'old' },
      { cwd: testRoot },
    );
    const second = normalizeToolOperation(
      'edit_file',
      { old_text: 'old', path: 'report.md', new_text: 'new' },
      { cwd: testRoot },
    );

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(decideOperationApproval(first)).toEqual(decideOperationApproval(second));
  });

  test('every currently registered tool has an explicit or legacy classification', () => {
    const unknown = getToolRegistry('test-model')
      .map((item) => item.name)
      .filter((name) => !isKnownToolOperation(name));

    expect(unknown).toEqual([]);
  });
  test('unknown operations fail closed', () => {
    const operation = normalizeToolOperation('future_mutator', {
      action: 'sync',
      target: 'remote',
    });

    expect(operation.known).toBe(false);
    expect(operation.risk).toBe('sensitive');
    expect(decideOperationApproval(operation).requirement).toBe('user_approval');
  });
});

describe('exact operation binding', () => {
  test('approved operation cannot change target before execution', async () => {
    const gate = new OperationApprovalGate(
      async () => 'allow-once',
      new Set(),
      { cwd: testRoot },
    );
    const approved = await gate.authorize('edit_file', {
      path: 'a.md',
      old_text: 'old',
      new_text: 'new',
    });

    expect(approved.allowed).toBe(true);
    expect(() => gate.claim('edit_file', {
      path: 'b.md',
      old_text: 'old',
      new_text: 'new',
    })).toThrow('not approved for this exact target');
    expect(() => gate.claim(
      'edit_file',
      approved.operation.arguments as Record<string, unknown>,
    )).toThrow('not approved for this exact target');
  });

  test('approved update cannot become delete', async () => {
    const gate = new OperationApprovalGate(async () => 'allow-once');
    const approved = await gate.authorize('memory_update', {
      action: 'edit',
      file: 'long_term',
      old_text: 'old',
      new_text: 'new',
    });

    expect(() => gate.claim('memory_update', {
      action: 'delete',
      file: 'MEMORY.md',
      old_text: 'old',
    })).toThrow('not approved for this exact target');
    expect(() => gate.claim(
      'memory_update',
      approved.operation.arguments as Record<string, unknown>,
    )).toThrow('not approved for this exact target');
  });

  test('batch scope remains bounded to the approved targets', async () => {
    const gate = new OperationApprovalGate(async () => 'allow-once');
    const approved = await gate.authorize('future_batch_mutator', {
      action: 'update',
      targets: ['a', 'b'],
    });

    expect(approved.operation.targets).toEqual(['a', 'b']);
    expect(() => gate.claim('future_batch_mutator', {
      action: 'update',
      targets: ['a', 'b', 'c'],
    })).toThrow('not approved for this exact target');
    expect(() => gate.claim(
      'future_batch_mutator',
      approved.operation.arguments as Record<string, unknown>,
    )).toThrow('not approved for this exact target');
  });

  test('identical session-approved retry does not prompt again', async () => {
    let prompts = 0;
    const session = new Set<string>();
    const gate = new OperationApprovalGate(async () => {
      prompts++;
      return 'allow-session';
    }, session, { cwd: testRoot });
    const args = { path: 'a.md', old_text: 'old', new_text: 'new' };

    const first = await gate.authorize('edit_file', args);
    gate.claim('edit_file', first.operation.arguments as Record<string, unknown>);
    const retry = await gate.authorize('edit_file', args);
    gate.claim('edit_file', retry.operation.arguments as Record<string, unknown>);

    expect(prompts).toBe(1);
    expect(retry.prompted).toBe(false);
  });

  test('changed retry is re-evaluated', async () => {
    let prompts = 0;
    const gate = new OperationApprovalGate(async () => {
      prompts++;
      return 'allow-session';
    }, new Set(), { cwd: testRoot });

    const first = await gate.authorize('edit_file', {
      path: 'a.md',
      old_text: 'old',
      new_text: 'new',
    });
    gate.claim('edit_file', first.operation.arguments as Record<string, unknown>);
    const changed = await gate.authorize('edit_file', {
      path: 'b.md',
      old_text: 'old',
      new_text: 'new',
    });

    expect(prompts).toBe(2);
    expect(changed.prompted).toBe(true);
  });

  test('bash session approval is exact and scoped to one query', async () => {
    let prompts = 0;
    const gate = new OperationApprovalGate(async (request) => {
      prompts++;
      expect(request.permission?.command).toBe('echo hi');
      return 'allow-session';
    }, new Set(), { cwd: testRoot });
    const permission = {
      mode: 'ask' as const,
      reason: 'Command requires approval.',
      command: 'echo hi',
      classification: 'unknown' as const,
      sessionCacheable: true,
    };
    const queryOne = new Set<string>();

    const first = await gate.authorize(
      'bash',
      { command: 'echo hi' },
      { permission, sessionApprovedOperations: queryOne },
    );
    gate.claim('bash', first.operation.arguments as Record<string, unknown>);
    const retry = await gate.authorize(
      'bash',
      { command: 'echo hi' },
      { permission, sessionApprovedOperations: queryOne },
    );
    gate.claim('bash', retry.operation.arguments as Record<string, unknown>);

    const nextQuery = await gate.authorize(
      'bash',
      { command: 'echo hi' },
      { permission, sessionApprovedOperations: new Set() },
    );

    expect(first.prompted).toBe(true);
    expect(retry.prompted).toBe(false);
    expect(nextQuery.prompted).toBe(true);
    expect(prompts).toBe(2);
  });

  test('bash permission deny fails closed without prompting', async () => {
    let prompts = 0;
    const gate = new OperationApprovalGate(async () => {
      prompts++;
      return 'allow-once';
    }, new Set(), { cwd: testRoot });

    const result = await gate.authorize('bash', { command: 'rm report.md' }, {
      permission: {
        mode: 'deny',
        reason: 'Denied by command policy.',
        command: 'rm report.md',
        classification: 'mutating',
        sessionCacheable: false,
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.prompted).toBe(false);
    expect(result.decision).toBe('deny');
    expect(prompts).toBe(0);
    expect(() => gate.claim('bash', { command: 'rm report.md' })).toThrow(
      'not approved for this exact target',
    );
  });

  test('bash approval cannot be reused for a changed command', async () => {
    let prompts = 0;
    const queryApprovals = new Set<string>();
    const gate = new OperationApprovalGate(async () => {
      prompts++;
      return 'allow-session';
    }, new Set(), { cwd: testRoot });
    const permission = {
      mode: 'ask' as const,
      reason: 'Command requires approval.',
      classification: 'unknown' as const,
      sessionCacheable: true,
    };

    const first = await gate.authorize('bash', { command: 'echo first' }, {
      permission: { ...permission, command: 'echo first' },
      sessionApprovedOperations: queryApprovals,
    });
    gate.claim('bash', first.operation.arguments as Record<string, unknown>);
    const changed = await gate.authorize('bash', { command: 'echo second' }, {
      permission: { ...permission, command: 'echo second' },
      sessionApprovedOperations: queryApprovals,
    });

    expect(changed.prompted).toBe(true);
    expect(prompts).toBe(2);
  });

  test('approval display is derived from the bound descriptor', () => {
    const operation = normalizeToolOperation(
      'edit_file',
      { path: 'a.md', old_text: 'old value', new_text: 'new value' },
      { cwd: testRoot },
    );
    const display = formatOperationForApproval(operation).join(String.fromCharCode(10));

    expect(display).toContain('Operation: file.update');
    expect(display).toContain('Target: ' + operation.target);
    expect(display).toContain('Old text: old value');
    expect(display).toContain('New text: new value');
    expect(display).toContain(operation.fingerprint.slice(0, 12));
  });
  test('an allow-once claim cannot be replayed', async () => {
    const gate = new OperationApprovalGate(async () => 'allow-once');
    const approved = await gate.authorize('memory_update', {
      action: 'append',
      file: 'long_term',
      content: 'remember this',
    });
    const args = approved.operation.arguments as Record<string, unknown>;

    expect(() => gate.claim('memory_update', args)).not.toThrow();
    expect(() => gate.claim('memory_update', args)).toThrow(
      'not approved for this exact target',
    );
  });
  test('memo approval binds the exact structured content and derived path', async () => {
    const gate = new OperationApprovalGate(
      async () => 'allow-once',
      new Set(),
      { cwd: testRoot, now: new Date('2026-09-19T09:00:00+09:00') },
    );
    const approved = await gate.authorize('write_memo', {
      document: { title: '承認対象', summary: '本文A' },
    });

    expect(() => gate.claim('write_memo', {
      document: { title: '承認対象', summary: '本文B' },
    })).toThrow('not approved for this exact target');
    expect(() => gate.claim(
      'write_memo',
      approved.operation.arguments as Record<string, unknown>,
    )).toThrow('not approved for this exact target');
  });

  test('binding comparison includes security-relevant arguments', () => {
    const approved = normalizeToolOperation(
      'edit_file',
      { path: 'a.md', old_text: 'old', new_text: 'safe' },
      { cwd: testRoot },
    );
    const changed = normalizeToolOperation(
      'edit_file',
      { path: 'a.md', old_text: 'old', new_text: 'different' },
      { cwd: testRoot },
    );

    expect(() => assertSameOperation(approved, changed)).toThrow(
      'Operation changed after approval',
    );
  });
});

describe('approval privacy boundary', () => {
  test('approval metadata and rejected operations are not durable memory', async () => {
    const memoryBase = join(testRoot, '.dexter');
    const memoryStore = new MemoryStore(memoryBase);
    const operation = normalizeToolOperation('memory_update', {
      action: 'append',
      file: 'long_term',
      content: 'transient approval payload',
    }, { cwd: testRoot });
    const request = createOperationApprovalRequest(operation);
    const gate = new OperationApprovalGate(async () => 'deny');
    const result = await gate.authorize(request.tool, request.args as Record<string, unknown>);

    expect(result.allowed).toBe(false);
    expect(await memoryStore.listMemoryFiles()).toEqual([]);
    expect(await memoryStore.readMemoryFile('MEMORY.md')).toBe('');
  });
});
