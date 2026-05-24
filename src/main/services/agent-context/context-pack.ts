export type ContextPackId =
  | 'courseProfile'
  | 'courseDagSummary'
  | 'courseProgress'
  | 'currentNode'
  | 'nodeOutline'
  | 'coverageIndex'
  | 'nodeMaterialsSummary'
  | 'activeFile'
  | 'ragSnippets'
  | 'studentMemory'
  | 'nodeHandoff'
  | 'attachments'
  | 'searchMode'
  | 'localeInstruction'
  | 'authoritativeSources'
  | 'practiceSourceBrief'
  | 'videoReferences'
  | 'userRequest';

export interface ContextPack {
  id: ContextPackId;
  content: string;
  title?: string;
}

export interface BuiltContext {
  packs: ContextPack[];
  content: string;
}

export function joinContextPacks(packs: ContextPack[], separator = '\n\n'): BuiltContext {
  return {
    packs,
    content: packs
      .map((pack) => pack.content)
      .filter(Boolean)
      .join(separator),
  };
}
