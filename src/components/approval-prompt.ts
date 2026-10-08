import { Container, Text, truncateToWidth } from '@mariozechner/pi-tui';
import type { ApprovalDecision } from '../agent/types.js';
import {
  formatOperationForApproval,
  type OperationApprovalRequest,
} from '../approval/operation-policy.js';
import { createApprovalSelector } from './select-list.js';
import { theme } from '../theme.js';

function formatToolLabel(tool: string): string {
  return tool
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export class ApprovalPromptComponent extends Container {
  readonly selector: any;
  onSelect?: (decision: ApprovalDecision) => void;

  constructor(request: OperationApprovalRequest) {
    super();
    this.selector = createApprovalSelector(
      (decision) => this.onSelect?.(decision),
      request.permission?.proposedRule,
      request.tool === 'bash',
    );
    const width = Math.max(20, process.stdout.columns ?? 80);
    const border = theme.warning('─'.repeat(width));

    this.addChild(new Text(border, 0, 0));
    this.addChild(new Text(theme.warning(theme.bold('Permission required')), 0, 0));
    this.addChild(new Text(formatToolLabel(request.tool), 0, 0));
    if (request.permission?.reason) {
      this.addChild(new Text(theme.muted(truncateToWidth(request.permission.reason, width, '…')), 0, 0));
    }
    for (const line of formatOperationForApproval(request.operation)) {
      this.addChild(new Text(line, 0, 0));
    }
    this.addChild(new Text(theme.muted('Do you want to allow this exact operation?'), 0, 0));
    this.addChild(new Text('', 0, 0));
    this.addChild(this.selector);
    this.addChild(new Text('', 0, 0));
    this.addChild(new Text(theme.muted('Enter to confirm · esc to deny'), 0, 0));
    this.addChild(new Text(border, 0, 0));
  }
}