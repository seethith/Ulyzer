import { describe, expect, it } from 'vitest';
import { parseDagJson } from './dag-json';

describe('parseDagJson repair', () => {
  it('removes self loops, duplicate edges, and unknown-node edges', () => {
    const parsed = parseDagJson(JSON.stringify({
      nodes: [
        { id: 'node_1', chapter: '基础', name: '入门', node_type: 'main', difficulty: 'beginner' },
        { id: 'node_2', chapter: '基础', name: '练习', node_type: 'invalid', difficulty: 'invalid' },
      ],
      edges: [
        { source: 'node_1', target: 'node_2' },
        { source: 'node_1', target: 'node_2' },
        { source: 'node_2', target: 'node_2' },
        { source: 'missing', target: 'node_2' },
      ],
    }));

    expect(parsed.edges).toEqual([{ source: 'node_1', target: 'node_2' }]);
    expect(parsed.nodes[1]).toMatchObject({
      node_type: 'main',
      difficulty: 'beginner',
      prerequisites: ['node_1'],
    });
    expect(parsed.repairReport).toMatchObject({
      normalizedFields: 2,
      droppedDuplicateEdges: 1,
      droppedUnknownEdges: 1,
      droppedSelfLoops: 1,
    });
  });

  it('uses prerequisites to add missing edges and skips cycle-forming edges', () => {
    const parsed = parseDagJson(JSON.stringify({
      nodes: [
        { id: 'node_1', chapter: '基础', name: 'A', prerequisites: ['node_3'] },
        { id: 'node_2', chapter: '基础', name: 'B', prerequisites: ['node_1'] },
        { id: 'node_3', chapter: '基础', name: 'C', prerequisites: ['node_2'] },
      ],
      edges: [],
    }));

    expect(parsed.edges).toEqual([
      { source: 'node_3', target: 'node_1' },
      { source: 'node_1', target: 'node_2' },
    ]);
    expect(parsed.nodes.find((node) => node.id === 'node_3')?.prerequisites).toEqual([]);
    expect(parsed.repairReport).toMatchObject({
      addedPrerequisiteEdges: 2,
      droppedCycleEdges: 1,
    });
  });

  it('removes transitive redundant edges while keeping reachability', () => {
    const parsed = parseDagJson(JSON.stringify({
      nodes: [
        { id: 'node_1', chapter: '基础', name: 'A' },
        { id: 'node_2', chapter: '基础', name: 'B' },
        { id: 'node_3', chapter: '基础', name: 'C' },
      ],
      edges: [
        { source: 'node_1', target: 'node_2' },
        { source: 'node_2', target: 'node_3' },
        { source: 'node_1', target: 'node_3' },
      ],
    }));

    expect(parsed.edges).toEqual([
      { source: 'node_1', target: 'node_2' },
      { source: 'node_2', target: 'node_3' },
    ]);
    expect(parsed.nodes.find((node) => node.id === 'node_3')?.prerequisites).toEqual(['node_2']);
    expect(parsed.repairReport).toMatchObject({
      droppedTransitiveEdges: 1,
    });
  });
});
