import { describe, expect, it } from 'vitest';
import { offsetsFeasible, type ParentContainmentEdge } from '../src/clockSolver.js';

function edge(
  parentService: number,
  childService: number,
  parentStart: number,
  parentEnd: number,
  childStart: number,
  childEnd: number,
): ParentContainmentEdge {
  return { parentService, childService, parentStart, parentEnd, childStart, childEnd };
}

describe('offsetsFeasible', () => {
  it('trivially feasible with one service (skew bounds alone)', () => {
    expect(offsetsFeasible(1, [], 10)).toBe(true);
  });

  it('zero skew: child already inside parent is feasible', () => {
    // parent [0,100], child [10,90]
    expect(offsetsFeasible(2, [edge(0, 1, 0, 100, 10, 90)], 0)).toBe(true);
  });

  it('zero skew: child ending after parent is infeasible', () => {
    // parent [0,100], child [10,110] -> child end exceeds parent by 10
    expect(offsetsFeasible(2, [edge(0, 1, 0, 100, 10, 110)], 0)).toBe(false);
  });

  it('zero skew: child starting before parent is infeasible', () => {
    // parent [0,100], child [-10,50]
    expect(offsetsFeasible(2, [edge(0, 1, 0, 100, -10, 50)], 0)).toBe(false);
  });

  it('correctable skew: child shifted late by 10, relative correction 10 needs skew >= 5 (both services may move)', () => {
    // parent [0,100], child [10,110]. With offsets o_p=+5, o_c=-5 both become
    // [5,105]: the 10us relative shift splits across the two services.
    expect(offsetsFeasible(2, [edge(0, 1, 0, 100, 10, 110)], 5)).toBe(true);
  });

  it('skew strictly smaller than needed is infeasible', () => {
    // max relative correction is 2*S = 8 < 10
    expect(offsetsFeasible(2, [edge(0, 1, 0, 100, 10, 110)], 4)).toBe(false);
  });

  it('offset bound itself must be respected: single cross-service relation forces |o| > S', () => {
    // same service both endpoints: relative offset must be 0 regardless of skew,
    // and child [0,10] vs parent [100,110] cannot be contained with 0 relative shift
    expect(offsetsFeasible(1, [edge(0, 0, 100, 110, 0, 10)], 1000)).toBe(false);
  });

  it('three-service chain: composable small shifts feasible', () => {
    // grandparent [0,1000] svc0, parent [150,950] svc1, grandchild [300,1000] svc2
    // each downstream clock runs 50 late-looking; skew 100 fixes
    const edges = [
      edge(0, 1, 0, 1000, 150, 950),
      edge(1, 2, 150, 950, 300, 1000),
    ];
    expect(offsetsFeasible(3, edges, 100)).toBe(true);
  });

  it('a single edge forcing a 100us relative shift needs skew >= 50 (both offsets bounded)', () => {
    // gp svc0 [100,1000], p svc1 [0,900]: start forces o1-o0 >= 100,
    // end forces o1-o0 <= 100, i.e. o1-o0 == 100. With both offsets in
    // [-S,S], exactly 2S >= 100 is required even though only one edge exists.
    const edges = [edge(0, 1, 100, 1000, 0, 900)];
    expect(offsetsFeasible(2, edges, 50)).toBe(true);
    expect(offsetsFeasible(2, edges, 49)).toBe(false);
  });

  it('sibling edges can jointly constrain one parent service offset', () => {
    // Two children each demand opposite corrections of the shared parent offset;
    // parent svc0, children svc1/svc2.
    // child1 appears too early by 10, child2 appears too late by 10; skew 10 solves both
    const edges = [
      edge(0, 1, 100, 200, 90, 190),
      edge(0, 2, 100, 200, 110, 210),
    ];
    expect(offsetsFeasible(3, edges, 10)).toBe(true);
    expect(offsetsFeasible(3, edges, 9)).toBe(false);
  });

  it('negative cycle formed by two cross-service edges in opposite directions', () => {
    // Simulate two spans where svc A is parent of B span and B is parent of
    // another A span with incompatible bounds: edge weights sum negative.
    // A->B containment requiring o_B - o_A <= -5, and B->A requiring o_A - o_B <= -5
    const edges = [
      // parent A [100,200], child B [100,200] shifted: require B earlier
      edge(0, 1, 100, 200, 105, 205), // end: o1-o0<=-5
      // parent B, child A: require A earlier than B
      edge(1, 0, 100, 200, 105, 205), // end: o0-o1<=-5
    ];
    expect(offsetsFeasible(2, edges, 1000)).toBe(false);
  });

  it('large skew does not rescue same-service inversion', () => {
    // both spans same service => relative offset exactly zero
    expect(offsetsFeasible(1, [edge(0, 0, 0, 10, 20, 30)], 50)).toBe(false);
  });
});
