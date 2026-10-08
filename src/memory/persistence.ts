import { MemoryStore } from './store.js';

export const EXPLICIT_MEMORY_UPDATE_ORIGIN = 'memory_update_tool' as const;

export type DurableMemoryMutation =
  | {
      origin: typeof EXPLICIT_MEMORY_UPDATE_ORIGIN;
      action: 'append';
      file: string;
      content: string;
    }
  | {
      origin: typeof EXPLICIT_MEMORY_UPDATE_ORIGIN;
      action: 'edit';
      file: string;
      oldText: string;
      newText: string;
    }
  | {
      origin: typeof EXPLICIT_MEMORY_UPDATE_ORIGIN;
      action: 'delete';
      file: string;
      oldText: string;
    };

/**
 * The only production boundary that mutates durable memory files.
 *
 * Callers must identify the explicit memory_update tool path. Conversation
 * messages, tool results, scratchpad entries, and compaction summaries never
 * satisfy this contract on their own.
 */
export class DurableMemoryPersistence {
  constructor(private readonly store: MemoryStore) {}

  async apply(mutation: DurableMemoryMutation): Promise<boolean> {
    if (mutation.origin !== EXPLICIT_MEMORY_UPDATE_ORIGIN) {
      throw new Error('Durable memory writes require the explicit memory_update tool path.');
    }

    switch (mutation.action) {
      case 'append':
        await this.store.appendMemoryFile(mutation.file, mutation.content);
        return true;
      case 'edit':
        return this.store.editInMemoryFile(mutation.file, mutation.oldText, mutation.newText);
      case 'delete':
        return this.store.deleteFromMemoryFile(mutation.file, mutation.oldText);
      default: {
        const unsupported: never = mutation;
        throw new Error('Unsupported durable memory mutation: ' + String(unsupported));
      }
    }
  }
}