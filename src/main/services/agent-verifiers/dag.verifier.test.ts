import { describe, expect, it } from 'vitest';
import { verifyDagAcyclic, verifyDagGoalCoverage } from './dag.verifier';

describe('dag verifiers', () => {
  const nodes = [
    { id: 'a', name: 'Python basics', description: 'Learn Python syntax' },
    { id: 'b', name: 'Data analysis', description: 'Use pandas for analysis' },
    { id: 'c', name: 'Machine learning', description: 'Train models' },
  ];

  it('passes acyclic DAGs', () => {
    const result = verifyDagAcyclic(nodes, [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]);

    expect(result.passed).toBe(true);
  });

  it('rejects cycles', () => {
    const result = verifyDagAcyclic(nodes, [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
    ]);

    expect(result.passed).toBe(false);
    expect(result.issues[0].code).toBe('dag.cycle_detected');
  });

  it('checks deterministic goal coverage', () => {
    const result = verifyDagGoalCoverage(nodes, 'Python data analysis');

    expect(result.passed).toBe(true);
  });
});
