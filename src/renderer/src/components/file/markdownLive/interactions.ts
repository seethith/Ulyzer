import { StateEffect } from '@codemirror/state';
import type { MarkdownRange } from './types';

export const revealMarkdownSourceEffect = StateEffect.define<MarkdownRange | null>();
