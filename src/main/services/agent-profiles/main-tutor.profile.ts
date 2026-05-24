import type { AgentProfile } from '../agent-core/run-state';

export const mainTutorProfile: AgentProfile = {
  id: 'main_tutor',
  agentChannel: 'main_tutor',
  scope: 'course',
  rolePromptKey: 'maintutor',
  allowedWorkflows: ['chat', 'route.generate'],
  defaultTools: [
    'read_roadmap',
    'add_node',
    'batch_add_nodes',
    'remove_node',
    'connect_nodes',
    'generate_dag',
    'update_profile',
    'analyze_dag',
    'web_search',
    'web_fetch',
    'search_library',
    'read_source',
    'update_node',
    'write_todos',
  ],
  contextPacks: [
    'courseProfile',
    'courseDagSummary',
    'courseProgress',
    'searchMode',
    'localeInstruction',
  ],
  // role + searchPolicy + modelIdentity + language. searchPolicy is wired so the
  // active search mode (web/library/off) is stated in the prompt, matching the
  // tool-set trimming applied at the loop boundary; 'auto' emits nothing.
  policyLayers: [
    'role',
    'searchPolicy',
    'modelIdentity',
    'language',
  ],
  memoryScopes: ['course', 'session'],
  artifactTypes: ['course_dag', 'chapter_structure', 'route_summary'],
  verifiers: ['dagAcyclic', 'dagGoalCoverage'],
  loopConfig: {
    maxTurns: 20,
    hardMaxTurns: 40,
    maxTokens: 16_000,
  },
};
