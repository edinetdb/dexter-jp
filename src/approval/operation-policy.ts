import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { resolveToCwd } from '../tools/filesystem/utils/path-utils.js';
import { getBrowserOperationTarget } from '../tools/browser/browser.js';
import {
  formatLocalMemoDate,
  MEMO_DIRECTORY,
  prepareWriteMemoInput,
  resolveMemoFilePath,
  type MemoDocument,
} from '../memo/document.js';
import { renderMemo } from '../memo/renderer.js';
import type { PermissionDecision } from '../permissions/types.js';

export type OperationRisk =
  | 'read_only'
  | 'local_mutation'
  | 'external_mutation'
  | 'destructive'
  | 'sensitive';

export type ApprovalDecision = 'allow-once' | 'allow-session' | 'allow-always' | 'deny';

export interface NormalizedOperation {
  readonly tool: string;
  readonly kind: string;
  readonly action: string;
  readonly risk: OperationRisk;
  readonly target?: string;
  readonly targets: readonly string[];
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
  readonly known: boolean;
}

export interface ApprovalPolicyDecision {
  readonly requirement: 'none' | 'user_approval';
  readonly reason: string;
}

export interface OperationApprovalRequest {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly operation: NormalizedOperation;
  readonly permission?: PermissionDecision;
}

export type RequestOperationApproval = (
  request: OperationApprovalRequest,
) => Promise<ApprovalDecision>;

export interface OperationAuthorizationOptions {
  /** Optional bash rule-engine verdict; operation normalization remains authoritative. */
  readonly permission?: PermissionDecision;
  /** Query-scoped exact fingerprints for bash allow-session decisions. */
  readonly sessionApprovedOperations?: Set<string>;
}

export interface OperationAuthorization {
  readonly allowed: boolean;
  readonly operation: NormalizedOperation;
  readonly policy: ApprovalPolicyDecision;
  readonly decision?: ApprovalDecision;
  readonly prompted: boolean;
}

export interface NormalizeOperationContext {
  readonly cwd?: string;
  readonly now?: Date;
}

interface ResolvedContext {
  readonly cwd: string;
  readonly now: Date;
}

interface OperationDraft {
  readonly kind: string;
  readonly action: string;
  readonly risk: OperationRisk;
  readonly target?: string;
  readonly targets?: readonly string[];
  readonly arguments?: Record<string, unknown>;
}

type OperationResolver = (
  args: Record<string, unknown>,
  context: ResolvedContext,
) => OperationDraft;

const LEGACY_READ_ONLY_TOOLS = new Set([
  'ask_user_question',
  'calculate_dcf',
  'company_screener',
  'get_analysis',
  'get_company_info',
  'get_earnings',
  'get_financial_statements',
  'get_financials',
  'get_key_ratios',
  'get_shareholders',
  'get_stock_price',
  'get_text_blocks',
  'memory_get',
  'memory_search',
  'read_filings',
  'screen_companies',
  'skill',
  'spawn_subagent',
  'web_fetch',
  'web_search',
  'x_search',
]);

function localDateFileName(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day + '.md';
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' ? args[key] : undefined;
}

function canonicalFileArguments(
  args: Record<string, unknown>,
  context: ResolvedContext,
): { args: Record<string, unknown>; target: string } {
  const rawPath = stringArg(args, 'path') ?? '<missing-path>';
  const target = rawPath === '<missing-path>'
    ? rawPath
    : resolveToCwd(rawPath, context.cwd);
  return { args: { ...args, path: target }, target };
}

const EXPLICIT_OPERATION_RESOLVERS: Readonly<Record<string, OperationResolver>> = {
  read_file: (args, context) => {
    const normalized = canonicalFileArguments(args, context);
    return {
      kind: 'file.read',
      action: 'read',
      risk: 'read_only',
      target: normalized.target,
      arguments: normalized.args,
    };
  },
  write_file: (args, context) => {
    const normalized = canonicalFileArguments(args, context);
    return {
      kind: 'file.write',
      action: 'create_or_overwrite',
      risk: 'destructive',
      target: normalized.target,
      arguments: normalized.args,
    };
  },
  edit_file: (args, context) => {
    const normalized = canonicalFileArguments(args, context);
    return {
      kind: 'file.update',
      action: 'update',
      risk: 'local_mutation',
      target: normalized.target,
      arguments: normalized.args,
    };
  },
  write_memo: (args, context) => {
    try {
      const prepared = prepareWriteMemoInput(args, formatLocalMemoDate(context.now));
      const target = resolveMemoFilePath(
        context.cwd,
        prepared.document.title,
        prepared.created,
      );
      return {
        kind: 'memo.create',
        action: 'create',
        risk: 'local_mutation',
        target,
        arguments: prepared,
      };
    } catch {
      return {
        kind: 'memo.invalid',
        action: 'create',
        risk: 'sensitive',
        target: resolve(context.cwd, MEMO_DIRECTORY),
        arguments: args,
      };
    }
  },
  bash: (args) => {
    const command = stringArg(args, 'command') ?? '';
    return {
      kind: 'shell.execute',
      action: 'execute',
      risk: 'sensitive',
      target: command || '<empty command>',
      arguments: args,
    };
  },
  sdk_user_input: (args) => ({
    kind: 'user_input.confirm',
    action: 'confirm',
    risk: 'sensitive',
    target: 'current-user',
    arguments: args,
  }),
  heartbeat: (args, context) => {
    const action = stringArg(args, 'action') ?? 'unknown';
    const target = resolve(context.cwd, '.dexter', 'HEARTBEAT.md');
    if (action === 'view') {
      return { kind: 'heartbeat.read', action, risk: 'read_only', target };
    }
    if (action === 'update') {
      return { kind: 'heartbeat.update', action, risk: 'external_mutation', target };
    }
    return { kind: 'heartbeat.unknown', action, risk: 'sensitive', target };
  },
  cron: (args) => {
    const action = stringArg(args, 'action') ?? 'unknown';
    const jobId = stringArg(args, 'jobId');
    const name = stringArg(args, 'name');
    const target = jobId
      ? 'cron-job:' + jobId
      : name
        ? 'cron-job:new:' + name
        : 'cron-jobs';
    switch (action) {
      case 'list':
        return { kind: 'cron.read', action, risk: 'read_only', target };
      case 'add':
      case 'update':
      case 'run':
        return { kind: 'cron.' + action, action, risk: 'external_mutation', target };
      case 'remove':
        return { kind: 'cron.delete', action, risk: 'destructive', target };
      default:
        return { kind: 'cron.unknown', action, risk: 'sensitive', target };
    }
  },
  memory_update: (args, context) => {
    const action = stringArg(args, 'action') ?? 'append';
    const requestedFile = stringArg(args, 'file') ?? 'long_term';
    const file = requestedFile === 'long_term'
      ? 'MEMORY.md'
      : requestedFile === 'daily'
        ? localDateFileName(context.now)
        : requestedFile;
    const normalizedArgs = { ...args, action, file };
    const target = resolve(context.cwd, '.dexter', 'memory', file);
    if (action === 'append' || action === 'edit') {
      return {
        kind: 'memory.' + action,
        action,
        risk: 'local_mutation',
        target,
        arguments: normalizedArgs,
      };
    }
    if (action === 'delete') {
      return {
        kind: 'memory.delete',
        action,
        risk: 'destructive',
        target,
        arguments: normalizedArgs,
      };
    }
    return {
      kind: 'memory.unknown',
      action,
      risk: 'sensitive',
      target,
      arguments: normalizedArgs,
    };
  },
  browser: (args) => {
    const action = stringArg(args, 'action') ?? 'unknown';
    if (action === 'navigate' || action === 'open') {
      const rawUrl = stringArg(args, 'url') ?? '<missing-url>';
      let target = rawUrl;
      try {
        target = new URL(rawUrl).toString();
      } catch {
        // The tool reports malformed URLs. The exact input remains bound.
      }
      return {
        kind: 'browser.' + action,
        action,
        risk: 'read_only',
        target,
        arguments: { ...args, url: target },
      };
    }
    if (action === 'snapshot' || action === 'read' || action === 'close') {
      return {
        kind: 'browser.' + action,
        action,
        risk: 'read_only',
        target: getBrowserOperationTarget(),
      };
    }
    if (action === 'act') {
      const request = args.request && typeof args.request === 'object'
        ? args.request as Record<string, unknown>
        : {};
      const actKind = stringArg(request, 'kind') ?? 'unknown';
      const ref = stringArg(request, 'ref');
      const key = stringArg(request, 'key');
      const target = getBrowserOperationTarget(ref, key);
      if (actKind === 'hover' || actKind === 'scroll' || actKind === 'wait') {
        return {
          kind: 'browser.act.' + actKind,
          action: actKind,
          risk: 'read_only',
          target,
        };
      }
      if (actKind === 'click' || actKind === 'type' || actKind === 'press') {
        return {
          kind: 'browser.act.' + actKind,
          action: actKind,
          risk: 'external_mutation',
          target,
        };
      }
      return {
        kind: 'browser.act.unknown',
        action: actKind,
        risk: 'sensitive',
        target,
      };
    }
    return {
      kind: 'browser.unknown',
      action,
      risk: 'sensitive',
      target: getBrowserOperationTarget(),
    };
  },
};

function normalizeValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) {
        normalized[key] = normalizeValue(source[key]);
      }
    }
    return normalized;
  }
  return String(value);
}

function normalizeArguments(args: Record<string, unknown>): Record<string, unknown> {
  return normalizeValue(args) as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function inferTargets(args: Record<string, unknown>): string[] {
  const candidates = args.targets ?? args.paths;
  if (!Array.isArray(candidates)) return [];
  return candidates.map(String);
}

function fingerprintOperation(
  operation: Omit<NormalizedOperation, 'fingerprint'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(operation))
    .digest('hex');
}

export function isKnownToolOperation(tool: string): boolean {
  return tool in EXPLICIT_OPERATION_RESOLVERS || LEGACY_READ_ONLY_TOOLS.has(tool);
}

export function normalizeToolOperation(
  tool: string,
  rawArgs: Record<string, unknown>,
  context: NormalizeOperationContext = {},
): NormalizedOperation {
  const resolvedContext: ResolvedContext = {
    cwd: context.cwd ?? process.cwd(),
    now: context.now ? new Date(context.now) : new Date(),
  };
  const baseArgs = normalizeArguments(rawArgs);
  const resolver = EXPLICIT_OPERATION_RESOLVERS[tool];
  const known = Boolean(resolver) || LEGACY_READ_ONLY_TOOLS.has(tool);
  const draft = resolver
    ? resolver(baseArgs, resolvedContext)
    : LEGACY_READ_ONLY_TOOLS.has(tool)
      ? {
          kind: tool + '.read',
          action: 'read',
          risk: 'read_only' as const,
          target: stringArg(baseArgs, 'path') ?? stringArg(baseArgs, 'url'),
        }
      : {
          kind: 'legacy.unknown',
          action: stringArg(baseArgs, 'action') ?? stringArg(baseArgs, 'command') ?? 'invoke',
          risk: 'sensitive' as const,
          target: stringArg(baseArgs, 'path') ?? stringArg(baseArgs, 'target') ?? tool,
          targets: inferTargets(baseArgs),
        };
  const normalizedArgs = normalizeArguments(draft.arguments ?? baseArgs);
  const targets = [...(draft.targets ?? inferTargets(normalizedArgs))].map(String);
  const withoutFingerprint: Omit<NormalizedOperation, 'fingerprint'> = {
    tool,
    kind: draft.kind,
    action: draft.action,
    risk: draft.risk,
    ...(draft.target ? { target: draft.target } : {}),
    targets,
    arguments: normalizedArgs,
    known,
  };
  const operation: NormalizedOperation = {
    ...withoutFingerprint,
    fingerprint: fingerprintOperation(withoutFingerprint),
  };
  return deepFreeze(operation);
}

export function decideOperationApproval(
  operation: NormalizedOperation,
): ApprovalPolicyDecision {
  if (operation.risk === 'read_only') {
    return {
      requirement: 'none',
      reason: 'The normalized operation is read-only.',
    };
  }
  if (!operation.known) {
    return {
      requirement: 'user_approval',
      reason: 'The operation is not classified as a known read-only capability.',
    };
  }
  return {
    requirement: 'user_approval',
    reason: 'The normalized operation is classified as ' + operation.risk + '.',
  };
}

export function createOperationApprovalRequest(
  operation: NormalizedOperation,
  permission?: PermissionDecision,
): OperationApprovalRequest {
  return deepFreeze({
    tool: operation.tool,
    args: operation.arguments,
    operation,
    ...(permission ? { permission } : {}),
  });
}

export function assertSameOperation(
  approved: NormalizedOperation,
  candidate: NormalizedOperation,
): void {
  if (approved.fingerprint !== candidate.fingerprint) {
    throw new Error(
      'Operation changed after approval: expected ' + approved.kind +
      ' (' + approved.fingerprint.slice(0, 12) + '), received ' +
      candidate.kind + ' (' + candidate.fingerprint.slice(0, 12) + ').',
    );
  }
}

function previewApprovalValue(value: unknown, maxLength = 160): string {
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  const text = encoded ?? String(value);
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= maxLength
    ? singleLine
    : singleLine.slice(0, maxLength - 1) + '…';
}

export function formatOperationForApproval(operation: NormalizedOperation): string[] {
  const risk = operation.risk.replace(/_/g, ' ');
  const lines = [
    'Operation: ' + operation.kind,
    'Action: ' + operation.action,
    'Risk: ' + risk,
  ];
  if (operation.target) lines.push('Target: ' + operation.target);
  if (operation.targets.length > 0) {
    lines.push('Targets: ' + operation.targets.join(', '));
  }

  const args = operation.arguments;
  if (operation.kind === 'file.write' && typeof args.content === 'string') {
    lines.push(
      'Content: ' + args.content.length + ' chars — ' +
      previewApprovalValue(args.content),
    );
  } else if (operation.kind === 'file.update') {
    lines.push('Old text: ' + previewApprovalValue(args.old_text));
    lines.push('New text: ' + previewApprovalValue(args.new_text));
  } else if (operation.kind === 'memo.create') {
    const document = args.document as MemoDocument | undefined;
    if (document?.title !== undefined) {
      lines.push('Title: ' + previewApprovalValue(document.title));
    }
    if (document && typeof args.created === 'string') {
      const markdown = renderMemo(document, { created: args.created });
      lines.push(
        'Content: ' + markdown.length + ' chars — ' +
        previewApprovalValue(markdown),
      );
    }
  } else if (operation.kind.startsWith('memory.')) {
    const value = args.content ?? args.old_text;
    if (value !== undefined) lines.push('Memory text: ' + previewApprovalValue(value));
    if (args.new_text !== undefined) {
      lines.push('Replacement: ' + previewApprovalValue(args.new_text));
    }
  } else if (operation.kind.startsWith('cron.')) {
    const details = {
      name: args.name,
      schedule: args.schedule,
      message: args.message,
      enabled: args.enabled,
      fulfillment: args.fulfillment,
    };
    lines.push('Details: ' + previewApprovalValue(details));
  } else if (
    operation.kind === 'heartbeat.update' &&
    args.content !== undefined
  ) {
    lines.push('Checklist: ' + previewApprovalValue(args.content));
  } else if (
    operation.kind === 'browser.act.type' &&
    args.request &&
    typeof args.request === 'object'
  ) {
    const request = args.request as Record<string, unknown>;
    lines.push('Text: ' + previewApprovalValue(request.text));
  } else if (!operation.known) {
    lines.push('Argument keys: ' + Object.keys(args).join(', '));
  }

  lines.push('Binding: ' + operation.fingerprint.slice(0, 12));
  return lines;
}

/**
 * Per-runtime authorization gate. Every allowed call receives a one-use claim
 * bound to its normalized fingerprint. Session approval stores fingerprints,
 * never a global boolean or a tool-wide bypass.
 */
export class OperationApprovalGate {
  private readonly pendingClaims = new Map<string, number>();
  private readonly context: NormalizeOperationContext;

  constructor(
    private readonly requestApproval?: RequestOperationApproval,
    private readonly sessionApprovedOperations: Set<string> = new Set(),
    context: NormalizeOperationContext = {},
  ) {
    // Freeze time for the runtime so date-derived targets cannot change between
    // approval and the exact execution claim (for example across midnight).
    this.context = {
      ...context,
      now: context.now ? new Date(context.now) : new Date(),
    };
  }

  async authorize(
    tool: string,
    args: Record<string, unknown>,
    options: OperationAuthorizationOptions = {},
  ): Promise<OperationAuthorization> {
    if (options.permission && tool !== 'bash') {
      throw new Error('Permission overrides are restricted to the bash tool.');
    }

    const operation = normalizeToolOperation(tool, args, this.context);
    const permission = options.permission;
    const policy: ApprovalPolicyDecision = permission
      ? {
          requirement: permission.mode === 'allow' ? 'none' : 'user_approval',
          reason: permission.reason,
        }
      : decideOperationApproval(operation);
    let decision: ApprovalDecision | undefined;
    let prompted = false;

    if (permission?.mode === 'deny') {
      return { allowed: false, operation, policy, decision: 'deny', prompted };
    }

    if (policy.requirement === 'user_approval') {
      const sessionApprovals =
        options.sessionApprovedOperations ?? this.sessionApprovedOperations;
      const cacheable = permission?.sessionCacheable !== false;
      if (cacheable && sessionApprovals.has(operation.fingerprint)) {
        decision = 'allow-session';
      } else {
        prompted = true;
        try {
          decision = this.requestApproval
            ? await this.requestApproval(
                createOperationApprovalRequest(operation, permission),
              )
            : 'deny';
        } catch {
          decision = 'deny';
        }
      }

      if (decision === 'deny') {
        return { allowed: false, operation, policy, decision, prompted };
      }
      if (decision === 'allow-always' && !permission?.proposedRule) {
        return { allowed: false, operation, policy, decision: 'deny', prompted };
      }
      if (decision === 'allow-session' && cacheable) {
        sessionApprovals.add(operation.fingerprint);
      }
    }

    this.pendingClaims.set(
      operation.fingerprint,
      (this.pendingClaims.get(operation.fingerprint) ?? 0) + 1,
    );
    return { allowed: true, operation, policy, decision, prompted };
  }

  claim(tool: string, args: Record<string, unknown>): NormalizedOperation {
    const candidate = normalizeToolOperation(tool, args, this.context);
    const count = this.pendingClaims.get(candidate.fingerprint) ?? 0;
    if (count < 1) {
      // Invalidate outstanding one-use claims on any mismatch. This prevents a
      // changed SDK/runtime call from leaving an old approval available to replay.
      this.pendingClaims.clear();
      throw new Error(
        'Operation ' + candidate.kind +
        ' was not approved for this exact target and argument set.',
      );
    }
    if (count === 1) this.pendingClaims.delete(candidate.fingerprint);
    else this.pendingClaims.set(candidate.fingerprint, count - 1);
    return candidate;
  }
}
