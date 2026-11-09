// Claims for rendering/the-pipeline.mdx: the counts the pipeline widget's scene produces.
import { claim, fact } from '../core';
import { pipelineRun, pipelineScene } from '../../../src/render/scenes/the-pipeline';

export default function pipeline(): void {
  const P = 'rendering/the-pipeline.mdx';
  const on = pipelineRun(0.1, true).stats;
  const off = pipelineRun(0.1, false).stats;
  const deep = pipelineRun(4.6, true).stats;
  const sc = pipelineScene();
  claim(P, `This frame has ${on.vertices} vertex shader runs: the floor's ${sc[0].mesh.positions.length} and the box's ${sc[1].mesh.positions.length}`);
  claim(P, `${on.triangles} triangles go in`);
  fact(P, on.clipped === 2, 'both floor triangles cross the near plane');
  claim(P, `both floor triangles cross the near plane and come out as ${on.clippedOut} triangles`);
  claim(P, `${on.backfacing} of the box's ${sc[1].mesh.indices.length / 3} face away from the camera`);
  claim(P, `${off.fragments} fragments, ${off.depthFailed} of which fail the depth test, against ${on.fragments} fragments with culling on`);
  claim(P, `${on.rasterised} triangles reach the rasteriser, and between them they produce ${on.fragments} fragments`);
  fact(P, on.depthFailed === 0, 'with culling on, nothing fails the depth test');
  fact(P, pipelineRun(1, true).stats.clipped === on.clipped, 'at 1 m the near plane still clips only the floor');
  claim(P, `${deep.clipped} of the ${deep.triangles} triangles are clipped, into ${deep.clippedOut}`);
}
