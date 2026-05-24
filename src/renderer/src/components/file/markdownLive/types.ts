export interface MarkdownRange {
  from: number;
  to: number;
}

export interface MarkdownMathRange extends MarkdownRange {
  bodyFrom: number;
  bodyTo: number;
  formula: string;
  displayMode: boolean;
}

export interface MarkdownImageRange extends MarkdownRange {
  alt: string;
  src: string;
}

export interface MarkdownCodeBlockRange extends MarkdownRange {
  info: string;
  code: string;
  codeFrom: number;
  codeTo: number;
}

export interface MarkdownTableRange extends MarkdownRange {
  source: string;
}

export interface MarkdownTaskMarkerRange extends MarkdownRange {
  checked: boolean;
}

export interface MarkdownLinkRange extends MarkdownRange {
  url: string;
  textFrom: number;
  textTo: number;
}
