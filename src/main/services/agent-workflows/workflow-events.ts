import type { FileGeneratedPayload, TokenUsage } from '@shared/types';
import type { WorkflowRunOptions } from './workflow-types';
import type { WorkflowLifecycle } from './workflow-lifecycle';

export function wrapProgress(
  original: (message: string) => void,
  options: WorkflowRunOptions,
  lifecycle?: WorkflowLifecycle,
): (message: string) => void {
  return (message) => {
    original(message);
    if (lifecycle) lifecycle.progress(message);
    else options.context?.progress(message);
  };
}

export function wrapUsage(
  original: ((usage: TokenUsage) => void) | undefined,
  options: WorkflowRunOptions,
  lifecycle?: WorkflowLifecycle,
): (usage: TokenUsage) => void {
  return (usage) => {
    original?.(usage);
    if (lifecycle) lifecycle.addUsage(usage);
    else options.context?.addUsage(usage);
  };
}

export function wrapFileGenerated(
  original: (payload: FileGeneratedPayload) => void,
  options: WorkflowRunOptions,
  lifecycle?: WorkflowLifecycle,
): (payload: FileGeneratedPayload) => void {
  return (payload) => {
    original(payload);
    if (lifecycle) lifecycle.fileGenerated(payload);
    else options.context?.fileGenerated(payload);
  };
}
