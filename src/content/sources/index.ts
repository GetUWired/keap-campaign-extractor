import type { ContentKind, ContentSource } from '../types.js';

/**
 * One source per content kind, each settled by phase 0
 * (docs/spike-findings.md, "Content sources"). Empty until the content-sources
 * plan lands; `fetch-content` reports every kind it cannot yet read.
 */
export const SOURCES: Partial<Record<ContentKind, ContentSource>> = {};
