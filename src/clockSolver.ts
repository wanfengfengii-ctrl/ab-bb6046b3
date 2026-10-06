/**
 * Per-service integer clock-offset feasibility for containment constraints.
 *
 * Every span of a service shares ONE unknown integer offset o_s, constrained
 * to [-S, +S] (S = maxClockSkewUs). Correcting a span (start, end) of service s
 * yields (start + o_s, end + o_s). For every parent edge p -> c the corrected
 * child must lie COMPLETELY inside the corrected parent:
 *
 *     start_p + o_p <= start_c + o_c       (child starts no earlier than parent)
 *       end_c + o_c <=   end_p + o_p       (child ends no later than parent)
 *
 * Rearranged into difference constraints (o_v - o_u <= w  <=>  edge u -> v):
 *
 *     o_p - o_c <= start_c - start_p       edge  c -> p, weight start_c - start_p
 *     o_c - o_p <=   end_p - end_c         edge  p -> c, weight   end_p - end_c
 *
 * Per-service skew limits are expressed against a virtual node Z fixed at 0:
 *
 *     o_s <=  S     edge Z -> s, weight S
 *    -o_s <=  S     edge s -> Z, weight S
 *
 * A feasible assignment exists iff the difference-constraint graph has no
 * negative cycle, which Bellman-Ford decides. All weights are integers and the
 * constraint matrix is totally unimodular, so whenever the relaxation is
 * feasible there is also an INTEGER feasible assignment — matching the
 * requirement that offsets be integers.
 */

export interface ParentContainmentEdge {
  parentService: number;
  childService: number;
  parentStart: number;
  parentEnd: number;
  childStart: number;
  childEnd: number;
}

/**
 * Decides whether one offset per service (indices 0..serviceCount-1) can
 * simultaneously satisfy every parent/child containment relation while
 * staying within +/- maxSkew.
 */
export function offsetsFeasible(
  serviceCount: number,
  parentEdges: ParentContainmentEdge[],
  maxSkew: number,
): boolean {
  // Node serviceCount is the virtual zero node (o_Z = 0).
  const zero = serviceCount;
  const nodeCount = serviceCount + 1;

  interface Edge {
    from: number;
    to: number;
    weight: number;
  }

  const edges: Edge[] = [];

  for (const e of parentEdges) {
    // start_p + o_p <= start_c + o_c  <=>  o_parent - o_child <= childStart - parentStart
    edges.push({
      from: e.childService,
      to: e.parentService,
      weight: e.childStart - e.parentStart,
    });
    // end_c + o_c <= end_p + o_p  <=>  o_child - o_parent <= parentEnd - childEnd
    edges.push({
      from: e.parentService,
      to: e.childService,
      weight: e.parentEnd - e.childEnd,
    });
  }

  // Skew bounds against the fixed zero node.
  for (let s = 0; s < serviceCount; s++) {
    edges.push({ from: zero, to: s, weight: maxSkew }); // o_s <= S
    edges.push({ from: s, to: zero, weight: maxSkew }); // o_s >= -S
  }

  // Bellman-Ford from an implicit super-source connected to every node with
  // weight 0: initialize all distances to 0, then relax up to n-1 times.
  const dist: number[] = new Array<number>(nodeCount).fill(0);

  for (let pass = 0; pass < nodeCount - 1; pass++) {
    let changed = false;
    for (const edge of edges) {
      const candidate = dist[edge.from]! + edge.weight;
      if (candidate < dist[edge.to]!) {
        dist[edge.to] = candidate;
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  // An edge that can still be tightened implies a negative cycle: no
  // assignment (not even a real-valued one) can satisfy all constraints.
  for (const edge of edges) {
    if (dist[edge.from]! + edge.weight < dist[edge.to]!) {
      return false;
    }
  }

  return true;
}
