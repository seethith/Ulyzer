import * as fs from 'fs';
import * as path from 'path';
import { generateOutlineV1 } from '../material/material-generation-loop';
import {
  generateNextOutlineVersion,
  getOutlineBundleStatus,
  getOutlineVersionNumber,
  removeOutlineVersionsFrom,
} from '../outline-version';
import { wrapProgress, wrapUsage } from '../workflow-events';
import { getLatestOutlinePath } from '../../fs/content.service';
import { createWorkflowLifecycle } from '../workflow-lifecycle';
import type {
  OutlineGenerateNextWorkflowInput,
  WorkflowDefinition,
  WorkflowRunOptions,
} from '../workflow-types';

export const outlineGenerateNextWorkflow: WorkflowDefinition<'outline.generateNext'> = {
  id: 'outline.generateNext',
  async run(input: OutlineGenerateNextWorkflowInput, options: WorkflowRunOptions) {
    const lifecycle = createWorkflowLifecycle('outline.generateNext', options);
    try {
      const runOptions = options.context
        ? {
            ...input.options,
            onProgressChunk: wrapProgress(input.options.onProgressChunk, options, lifecycle),
            onComplete:      wrapUsage(input.options.onComplete, options, lifecycle),
          }
        : input.options;
      const status = await lifecycle.runPhase('prepare_context', () =>
        getOutlineBundleStatus(runOptions.courseId, runOptions.nodeId));
      if (status.complete) {
        lifecycle.skip('retrieve_sources');
        lifecycle.skip('generate_content');
        lifecycle.skip('verify');
        lifecycle.skip('persist_artifacts');
        lifecycle.skip('emit_result');
        return { version: 3, skipped: true, staleVersions: [] };
      }

      const earliestRefresh = Math.min(...status.missingVersions, ...status.staleVersions) as 1 | 2 | 3;
      if (Number.isFinite(earliestRefresh)) {
        removeOutlineVersionsFrom(runOptions.courseId, runOptions.nodeId, earliestRefresh);
      }

      let currentVersion = getOutlineVersionNumber(runOptions.courseId, runOptions.nodeId);
      const generatedVersions: number[] = [];

      if (currentVersion === 0) lifecycle.start('retrieve_sources');
      else lifecycle.skip('retrieve_sources');

      lifecycle.start('generate_content');
      if (currentVersion === 0) {
        await generateOutlineV1(runOptions, input.node);
        generatedVersions.push(1);
        currentVersion = 1;
        lifecycle.complete('retrieve_sources');
      }

      while (currentVersion < 3) {
        currentVersion = await generateNextOutlineVersion(runOptions, input.node);
        generatedVersions.push(currentVersion);
      }
      lifecycle.complete('generate_content');
      lifecycle.skip('verify');
      lifecycle.complete('persist_artifacts', emitOutlineFiles(runOptions.courseId, runOptions.nodeId, lifecycle));
      lifecycle.complete('emit_result');
      return { version: currentVersion, skipped: false, generatedVersions, staleVersions: status.staleVersions };
    } catch (err) {
      throw lifecycle.fail(err);
    }
  },
};

function emitOutlineFiles(courseId: string, nodeId: string, lifecycle: ReturnType<typeof createWorkflowLifecycle>): string[] {
  const latestPath = getLatestOutlinePath(courseId, nodeId);
  if (!latestPath) return [];
  const folder = path.dirname(latestPath);
  const filePaths = [1, 2, 3]
    .map((version) => path.join(folder, `_outline_v${version}.md`))
    .filter((filePath) => fs.existsSync(filePath));
  for (const filePath of filePaths) {
    lifecycle.fileGenerated({ filePath, folderName: 'outline', nodeId });
  }
  return filePaths;
}
