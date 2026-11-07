// Claims for rendering/nanite-in-brief.mdx: the cluster hierarchy (levels, coarsest cut, segments
// drawn near and far, no cracks) and the small-triangle quad table.
import { claim, fact, int } from '../core';
import { QUAD_DIVS, QUAD_PX, SEGMENTS, VIEW_START, buildHierarchy, coarsest, cut, laneUse, quadModel } from '../../../src/render/scenes/nanite-in-brief';

export default function nanite(): void {
  const D = 'rendering/nanite-in-brief.mdx';
  const dag = buildHierarchy('dag');
  const alone = buildHierarchy('alone');
  claim(D, `${int(SEGMENTS)} segments in ${dag.levels[0].length} clusters of 8`);
  claim(D, `${dag.levels.length} levels, ${dag.levels.map((l) => l.length).join(', ')} clusters`);
  claim(D, `the coarsest cut is ${coarsest(dag)} segments; built cluster by cluster it can't go below ${coarsest(alone)}`);
  const a = cut(dag, VIEW_START, 1);
  const b = cut(alone, VIEW_START, 1);
  claim(D, `from where the viewer starts, with 1 pixel of error allowed, the DAG draws ${a.segments} segments and the cluster-by-cluster build ${b.segments}`);
  fact(D, b.segments < a.segments, 'up close the per-cluster build draws fewer segments');
  // Backing away from the outline's middle, in the start direction.
  const pts = dag.pts;
  const C = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  const dx = VIEW_START.x - C.x;
  const dy = VIEW_START.y - C.y;
  const L = Math.sqrt(dx * dx + dy * dy);
  const at = (d: number) => ({ x: C.x + (dx / L) * d, y: C.y + (dy / L) * d });
  const far = [1000, 3000, 10000].map((d) => cut(dag, at(d), 1).segments);
  claim(D, `the DAG keeps going down, ${far[0]} segments at a distance of 1,000, ${far[1]} at 3,000, ${far[2]} at 10,000`);
  fact(D, [1000, 3000, 10000].every((d) => cut(alone, at(d), 1).segments === coarsest(alone)), 'the per-cluster build is stuck at 128 from 1,000 on');
  // No cracks anywhere: every cut over a grid of viewer positions and thresholds tiles the loop exactly.
  let n = 0;
  let bad = 0;
  for (const hy of [dag, alone])
    for (let x = -200; x <= 840; x += 40)
      for (let y = -200; y <= 600; y += 40)
        for (const t of [0.25, 0.5, 1, 2, 4, 8]) {
          n++;
          if (!cut(hy, { x, y }, t).watertight) bad++;
        }
  fact(D, bad === 0, `every cut is watertight (${bad} of ${n} were not)`);
  claim(D, `${int(n)} cuts`);

  // Quads.
  for (const d of QUAD_DIVS) {
    const q = quadModel(d);
    claim(D, `| ${int(q.triangles)} | ${(QUAD_PX * QUAD_PX) / q.triangles} | ${int(4 * q.quads)} | ${laneUse(q).toFixed(1)}% |`);
  }
  const q32 = quadModel(32);
  claim(D, `${int(q32.empty)} of the ${int(q32.triangles)} triangles cover no pixel centre at all`);
}
