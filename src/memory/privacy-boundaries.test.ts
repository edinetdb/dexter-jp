import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSdkAgentSystemPrompt } from '../agent/sdk-prompt.js';
import { buildDexterSdkTools } from '../agent/sdk-tool-adapter.js';
import { Scratchpad } from '../agent/scratchpad.js';
import { LongTermChatHistory } from '../utils/long-term-chat-history.js';
import { TransientToolResultStore } from '../utils/tool-result-storage.js';
import { MemoryDatabase } from './database.js';
import { MemoryIndexer, LEGACY_SESSION_FILE_PATH } from './indexer.js';
import {
  DurableMemoryPersistence,
  EXPLICIT_MEMORY_UPDATE_ORIGIN,
  type DurableMemoryMutation,
} from './persistence.js';
import { MemoryStore } from './store.js';

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
  testRoot = mkdtempSync(join(tmpdir(), 'dexter-memory-privacy-'));
});

afterEach(() => {
  if (testRoot && existsSync(testRoot)) {
    removeTestRoot(testRoot);
  }
  testRoot = '';
});

describe('durable memory persistence boundary', () => {
  test('scratchpad, intermediate tool output, and compacted state are not persisted', async () => {
    const memoryBase = join(testRoot, '.dexter');
    const store = new MemoryStore(memoryBase);
    const scratchpad = new Scratchpad('research query');

    scratchpad.addThinking('candidate hypothesis');
    scratchpad.addToolResult('web_search', { query: 'candidate' }, 'temporary result');
    scratchpad.setCompactionSummary('compacted transient state');

    expect(scratchpad.getToolResults()).toContain('compacted transient state');
    expect(await store.listMemoryFiles()).toEqual([]);

    const restartedStore = new MemoryStore(memoryBase);
    expect(await restartedStore.listMemoryFiles()).toEqual([]);
    expect(await restartedStore.readMemoryFile('MEMORY.md')).toBe('');
  });

  test('intermediate tool-output offloads are removed with the run state', () => {
    const transientStore = new TransientToolResultStore(join(testRoot, 'tool-results'));
    const { filePath } = transientStore.persist(
      'web_search',
      'call-1',
      'temporary tool output',
    );

    expect(existsSync(filePath)).toBe(true);
    transientStore.dispose();
    expect(existsSync(filePath)).toBe(false);
    expect(() => transientStore.persist('web_search', 'call-2', 'late output'))
      .toThrow('already disposed');
  });

  test('intentionally persisted memory survives a store restart', async () => {
    const memoryBase = join(testRoot, '.dexter');
    const persistence = new DurableMemoryPersistence(new MemoryStore(memoryBase));

    await persistence.apply({
      origin: EXPLICIT_MEMORY_UPDATE_ORIGIN,
      action: 'append',
      file: 'MEMORY.md',
      content: '- Risk tolerance: conservative',
    });

    const restartedStore = new MemoryStore(memoryBase);
    expect(await restartedStore.readMemoryFile('MEMORY.md'))
      .toContain('Risk tolerance: conservative');

    const context = await restartedStore.loadSessionContext(1_000);
    expect(context.filesLoaded).toContain('MEMORY.md');
    expect(context.text).toContain('Risk tolerance: conservative');
  });

  test('supported explicit edit and delete operations remain functional', async () => {
    const store = new MemoryStore(join(testRoot, '.dexter'));
    const persistence = new DurableMemoryPersistence(store);

    await persistence.apply({
      origin: EXPLICIT_MEMORY_UPDATE_ORIGIN,
      action: 'append',
      file: 'MEMORY.md',
      content: '- Horizon: 5 years',
    });
    expect(await persistence.apply({
      origin: EXPLICIT_MEMORY_UPDATE_ORIGIN,
      action: 'edit',
      file: 'MEMORY.md',
      oldText: '5 years',
      newText: '10 years',
    })).toBe(true);
    expect(await store.readMemoryFile('MEMORY.md')).toContain('10 years');

    expect(await persistence.apply({
      origin: EXPLICIT_MEMORY_UPDATE_ORIGIN,
      action: 'delete',
      file: 'MEMORY.md',
      oldText: '- Horizon: 10 years',
    })).toBe(true);
    expect(await store.readMemoryFile('MEMORY.md')).not.toContain('Horizon');
  });

  test('rejects writes that do not identify the explicit memory_update path', async () => {
    const persistence = new DurableMemoryPersistence(
      new MemoryStore(join(testRoot, '.dexter')),
    );
    const implicitConversationWrite = {
      origin: 'conversation_message',
      action: 'append',
      file: 'MEMORY.md',
      content: 'ordinary conversation',
    } as unknown as DurableMemoryMutation;

    await expect(persistence.apply(implicitConversationWrite))
      .rejects.toThrow('explicit memory_update tool path');
  });

  test('persistent CLI history remains separate from durable memory', async () => {
    const history = new LongTermChatHistory(testRoot);
    await history.load();
    await history.addUserMessage('temporary conversation state');
    await history.updateAgentResponse('temporary assistant response');

    const memoryStore = new MemoryStore(join(testRoot, '.dexter'));
    expect(await memoryStore.listMemoryFiles()).toEqual([]);
    expect(await memoryStore.readMemoryFile('MEMORY.md')).toBe('');
  });

  test('legacy conversation transcript chunks and embeddings are purged', async () => {
    const memoryBase = join(testRoot, '.dexter');
    const store = new MemoryStore(memoryBase);
    const db = await MemoryDatabase.create(join(store.getMemoryDir(), 'index.sqlite'));
    const content = 'User: transient question\nAssistant: transient answer';
    const contentHash = createHash('sha256').update(content).digest('hex');

    try {
      db.setCachedEmbedding({
        contentHash,
        embedding: [0.1, 0.2],
        provider: 'test',
        model: 'test',
      });
      db.upsertChunk({
        chunk: {
          filePath: LEGACY_SESSION_FILE_PATH,
          startLine: 1,
          endLine: 2,
          content,
          contentHash,
        },
        embedding: [0.1, 0.2],
        source: 'sessions',
      });

      const indexer = new MemoryIndexer(store, db, {
        chunkTokens: 400,
        overlapTokens: 80,
        watchDebounceMs: 10,
        embeddingClient: null,
      });
      const stats = await indexer.sync();

      expect(stats.removedChunks).toBe(1);
      expect(db.listIndexedFiles()).not.toContain(LEGACY_SESSION_FILE_PATH);
      expect(db.getCachedEmbedding(contentHash)).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('SDK memory isolation', () => {
  test('does not inject durable memory context or expose memory tools', async () => {
    const prompt = await buildSdkAgentSystemPrompt('claude-sonnet', 'cli');
    const toolNames = buildDexterSdkTools()
      .map((tool) => (tool as { name?: string }).name ?? '');

    expect(prompt).not.toContain('### User context');
    expect(toolNames).not.toContain('memory_search');
    expect(toolNames).not.toContain('memory_get');
    expect(toolNames).not.toContain('memory_update');
  });
});