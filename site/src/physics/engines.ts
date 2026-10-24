/**
 * Real 3D engines behind one small interface, for the Jolt, Box3D and Bullet lesson: Jolt through its
 * official WebAssembly build (JoltPhysics.js), Box3D through our own build (box3d-wasm/). Both
 * run single-threaded on the main thread. Scenes are plain data, so both engines get the same
 * bodies with the same sizes, masses and materials.
 */

export type Kind = 'box' | 'sphere';
export interface BodySpec {
  kind: Kind;
  dynamic: boolean;
  pos: [number, number, number];
  /** Box half extents, or [radius] for spheres. */
  size: number[];
  quat?: [number, number, number, number];
  vel?: [number, number, number];
  /** kg/m³ */
  density?: number;
  friction?: number;
  restitution?: number;
  /** Ask for continuous collision (Jolt LinearCast, Box3D bullet). */
  fast?: boolean;
  colour?: number;
}
export interface Scene3D {
  name: string;
  bodies: BodySpec[];
  camera: { eye: [number, number, number]; target: [number, number, number]; fov: number };
}

export interface EngineStats {
  bodies: number;
  awake: number;
  /** Milliseconds the last step took in this browser (varies by machine). */
  stepMs: number;
}

export interface Engine3D {
  readonly name: string;
  readonly ready: boolean;
  load(): Promise<void>;
  reset(scene: Scene3D): void;
  step(dt: number): void;
  /** 8 floats per body: position, quaternion (x, y, z, w), awake. */
  read(out: Float32Array): number;
  stats(): EngineStats;
  /** Settings the lesson toggles. */
  /** substeps: Box3D sub-steps, Jolt collision steps, Bullet internal steps. velocitySteps: Jolt velocity steps, Bullet solver iterations. */
  options: { substeps: number; linearCast: boolean; sleep: boolean; continuous: boolean; velocitySteps: number };
}

// ---------------------------------------------------------------------------------------------
// Box3D (our wasm build)

interface Box3DExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  bw_create(gx: number, gy: number, gz: number, sleep: number, hz: number, continuous: number): number;
  bw_destroy(): void;
  bw_add_box(t: number, x: number, y: number, z: number, hx: number, hy: number, hz: number, qx: number, qy: number, qz: number, qs: number, vx: number, vy: number, vz: number, d: number, f: number, r: number): number;
  bw_add_sphere(t: number, x: number, y: number, z: number, r: number, vx: number, vy: number, vz: number, d: number, f: number, rest: number, bullet: number): number;
  bw_step(dt: number, sub: number): void;
  bw_transforms(ptr: number): number;
  bw_counters(ptr: number): void;
  bw_scratch(): number;
}

export class Box3DEngine implements Engine3D {
  readonly name = 'Box3D';
  ready = false;
  options = { substeps: 4, linearCast: false, sleep: true, continuous: true, velocitySteps: 0 };
  private x!: Box3DExports;
  private last = 0;
  constructor(private url: string | (() => Promise<BufferSource>)) {}

  async load(): Promise<void> {
    const src = typeof this.url === 'string' ? await (await fetch(this.url)).arrayBuffer() : await this.url();
    let mem: WebAssembly.Memory | null = null;
    const wasi = {
      fd_close: () => 0,
      fd_fdstat_get: () => 8,
      fd_seek: () => 8,
      fd_write: (_fd: number, iovs: number, n: number, written: number) => {
        const dv = new DataView(mem!.buffer);
        let t = 0;
        for (let i = 0; i < n; i++) t += dv.getUint32(iovs + i * 8 + 4, true);
        dv.setUint32(written, t, true);
        return 0;
      },
    };
    const { instance } = await WebAssembly.instantiate(src, { wasi_snapshot_preview1: wasi });
    this.x = instance.exports as unknown as Box3DExports;
    mem = this.x.memory;
    this.x._initialize();
    this.ready = true;
  }

  reset(scene: Scene3D): void {
    const x = this.x;
    x.bw_create(0, -10, 0, this.options.sleep ? 1 : 0, 0, this.options.continuous ? 1 : 0);
    for (const b of scene.bodies) {
      const t = b.dynamic ? 2 : 0;
      const q = b.quat ?? [0, 0, 0, 1];
      const v = b.vel ?? [0, 0, 0];
      const d = b.density ?? 1000;
      if (b.kind === 'box') x.bw_add_box(t, ...b.pos, b.size[0], b.size[1], b.size[2], q[0], q[1], q[2], q[3], ...v, d, b.friction ?? 0.6, b.restitution ?? 0);
      else x.bw_add_sphere(t, ...b.pos, b.size[0], ...v, d, b.friction ?? 0.6, b.restitution ?? 0, 0);
    }
  }

  step(dt: number): void {
    const t0 = performance.now();
    this.x.bw_step(dt, this.options.substeps);
    this.last = performance.now() - t0;
  }

  read(out: Float32Array): number {
    const p = this.x.bw_scratch();
    const n = this.x.bw_transforms(p);
    out.set(new Float32Array(this.x.memory.buffer, p, n * 8));
    return n;
  }

  stats(): EngineStats {
    const p = this.x.bw_scratch();
    this.x.bw_counters(p);
    const c = new Int32Array(this.x.memory.buffer, p, 4);
    return { bodies: c[0], awake: c[3], stepMs: this.last };
  }
}

// ---------------------------------------------------------------------------------------------
// Jolt (JoltPhysics.js)

/* eslint-disable @typescript-eslint/no-explicit-any */
type JoltModule = any;

export class JoltEngine implements Engine3D {
  readonly name = 'Jolt';
  ready = false;
  options = { substeps: 1, linearCast: false, sleep: true, continuous: true, velocitySteps: 10 };
  private J!: JoltModule;
  private jolt: any = null;
  private ids: any[] = [];
  private bi: any;
  private last = 0;
  constructor(private init: () => Promise<JoltModule>) {}

  async load(): Promise<void> {
    this.J = await this.init();
    this.ready = true;
  }

  reset(scene: Scene3D): void {
    const J = this.J;
    if (this.jolt) {
      for (const id of this.ids) J.destroy(id);
      J.destroy(this.jolt);
      this.jolt = null;
    }
    // Two object layers (non-moving, moving) mapped to two broadphase layers: the usual start.
    const NON_MOVING = 0;
    const MOVING = 1;
    const settings = new J.JoltSettings();
    const pairs = new J.ObjectLayerPairFilterTable(2);
    pairs.EnableCollision(NON_MOVING, MOVING);
    pairs.EnableCollision(MOVING, MOVING);
    const bpStatic = new J.BroadPhaseLayer(0);
    const bpMoving = new J.BroadPhaseLayer(1);
    const bpl = new J.BroadPhaseLayerInterfaceTable(2, 2);
    bpl.MapObjectToBroadPhaseLayer(NON_MOVING, bpStatic);
    bpl.MapObjectToBroadPhaseLayer(MOVING, bpMoving);
    settings.mObjectLayerPairFilter = pairs;
    settings.mBroadPhaseLayerInterface = bpl;
    settings.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(bpl, 2, pairs, 2);
    settings.mMaxBodies = 4096;
    settings.mMaxBodyPairs = 16384;
    settings.mMaxContactConstraints = 16384;
    this.jolt = new J.JoltInterface(settings);
    J.destroy(settings);
    const ps = this.jolt.GetPhysicsSystem();
    ps.SetGravity(new J.Vec3(0, -10, 0));
    const phs = ps.GetPhysicsSettings();
    phs.mAllowSleeping = this.options.sleep;
    phs.mNumVelocitySteps = this.options.velocitySteps;
    ps.SetPhysicsSettings(phs);
    this.bi = ps.GetBodyInterface();
    this.ids = [];
    for (const b of scene.bodies) {
      let shapeSettings: any;
      if (b.kind === 'box') {
        const he = new J.Vec3(b.size[0], b.size[1], b.size[2]);
        shapeSettings = new J.BoxShapeSettings(he, Math.min(0.05, 0.5 * Math.min(...b.size)));
        J.destroy(he);
      } else shapeSettings = new J.SphereShapeSettings(b.size[0]);
      shapeSettings.mDensity = b.density ?? 1000;
      const shape = shapeSettings.Create().Get();
      const q = b.quat ?? [0, 0, 0, 1];
      const pos = new J.RVec3(...b.pos);
      const rot = new J.Quat(q[0], q[1], q[2], q[3]);
      const cs = new J.BodyCreationSettings(shape, pos, rot, b.dynamic ? J.EMotionType_Dynamic : J.EMotionType_Static, b.dynamic ? MOVING : NON_MOVING);
      cs.mFriction = b.friction ?? 0.6;
      cs.mRestitution = b.restitution ?? 0;
      if (b.fast && this.options.linearCast) cs.mMotionQuality = J.EMotionQuality_LinearCast;
      if (b.vel) cs.mLinearVelocity = new J.Vec3(...b.vel);
      // The binding returns ids in a shared temporary: keep a copy of each.
      const tmp = this.bi.CreateAndAddBody(cs, b.dynamic ? J.EActivation_Activate : J.EActivation_DontActivate);
      this.ids.push(new J.BodyID(tmp.GetIndexAndSequenceNumber()));
      J.destroy(cs);
      J.destroy(pos);
      J.destroy(rot);
      J.destroy(shapeSettings);
    }
    ps.OptimizeBroadPhase();
  }

  step(dt: number): void {
    const t0 = performance.now();
    this.jolt.Step(dt, this.options.substeps);
    this.last = performance.now() - t0;
  }

  read(out: Float32Array): number {
    const bi = this.bi;
    this.ids.forEach((id, i) => {
      const p = bi.GetPosition(id);
      const q = bi.GetRotation(id);
      const o = i * 8;
      out[o] = p.GetX();
      out[o + 1] = p.GetY();
      out[o + 2] = p.GetZ();
      out[o + 3] = q.GetX();
      out[o + 4] = q.GetY();
      out[o + 5] = q.GetZ();
      out[o + 6] = q.GetW();
      out[o + 7] = bi.IsActive(id) ? 1 : 0;
    });
    return this.ids.length;
  }

  stats(): EngineStats {
    const ps = this.jolt.GetPhysicsSystem();
    return { bodies: ps.GetNumBodies(), awake: ps.GetNumActiveBodies(this.J.EBodyType_RigidBody), stepMs: this.last };
  }
}

// ---------------------------------------------------------------------------------------------
// Bullet (our wasm build)

interface BulletExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  bt_create(gx: number, gy: number, gz: number, iterations: number, sleep: number, split: number): number;
  bt_add_box(dyn: number, x: number, y: number, z: number, hx: number, hy: number, hz: number, qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number, d: number, f: number, r: number, sleep: number): number;
  bt_add_sphere(dyn: number, x: number, y: number, z: number, r: number, vx: number, vy: number, vz: number, d: number, f: number, rest: number, sleep: number, ccd: number): number;
  bt_step(dt: number, sub: number): void;
  bt_transforms(ptr: number): number;
  bt_counters(ptr: number): void;
  bt_scratch(): number;
}

export class BulletEngine implements Engine3D {
  readonly name = 'Bullet';
  ready = false;
  /** linearCast here means Bullet's per-body CCD (a swept sphere); continuous is unused. */
  options = { substeps: 1, linearCast: false, sleep: true, continuous: true, velocitySteps: 10 };
  private x!: BulletExports;
  private last = 0;
  constructor(private url: string | (() => Promise<BufferSource>)) {}

  async load(): Promise<void> {
    const src = typeof this.url === 'string' ? await (await fetch(this.url)).arrayBuffer() : await this.url();
    let mem: WebAssembly.Memory | null = null;
    const wasi = {
      fd_close: () => 0,
      fd_seek: () => 8,
      fd_write: (_fd: number, iovs: number, n: number, written: number) => {
        const dv = new DataView(mem!.buffer);
        let t = 0;
        for (let i = 0; i < n; i++) t += dv.getUint32(iovs + i * 8 + 4, true);
        dv.setUint32(written, t, true);
        return 0;
      },
    };
    const { instance } = await WebAssembly.instantiate(src, { wasi_snapshot_preview1: wasi });
    this.x = instance.exports as unknown as BulletExports;
    mem = this.x.memory;
    this.x._initialize();
    this.ready = true;
  }

  reset(scene: Scene3D): void {
    const x = this.x;
    const sleep = this.options.sleep ? 1 : 0;
    x.bt_create(0, -10, 0, this.options.velocitySteps, sleep, 1);
    for (const b of scene.bodies) {
      const q = b.quat ?? [0, 0, 0, 1];
      const v = b.vel ?? [0, 0, 0];
      const d = b.density ?? 1000;
      if (b.kind === 'box') x.bt_add_box(b.dynamic ? 1 : 0, ...b.pos, b.size[0], b.size[1], b.size[2], q[0], q[1], q[2], q[3], ...v, d, b.friction ?? 0.6, b.restitution ?? 0, sleep);
      else x.bt_add_sphere(b.dynamic ? 1 : 0, ...b.pos, b.size[0], ...v, d, b.friction ?? 0.6, b.restitution ?? 0, sleep, b.fast && this.options.linearCast ? 1 : 0);
    }
  }

  step(dt: number): void {
    const t0 = performance.now();
    this.x.bt_step(dt, this.options.substeps);
    this.last = performance.now() - t0;
  }

  read(out: Float32Array): number {
    const p = this.x.bt_scratch();
    const n = this.x.bt_transforms(p);
    out.set(new Float32Array(this.x.memory.buffer, p, n * 8));
    return n;
  }

  stats(): EngineStats {
    const p = this.x.bt_scratch();
    this.x.bt_counters(p);
    const c = new Int32Array(this.x.memory.buffer, p, 4);
    return { bodies: c[0], awake: c[3], stepMs: this.last };
  }
}

// ---------------------------------------------------------------------------------------------
// Scenes

function ground(size = 40): BodySpec {
  return { kind: 'box', dynamic: false, pos: [0, -0.5, 0], size: [size, 0.5, size] };
}

export const SCENES: Record<string, () => Scene3D> = {
  pyramid: () => {
    const bodies: BodySpec[] = [ground()];
    const rows = 12;
    for (let r = 0; r < rows; r++)
      for (let i = 0; i < rows - r; i++) bodies.push({ kind: 'box', dynamic: true, pos: [(i - (rows - r - 1) / 2) * 1.0, 0.5 + r * 1.0, 0], size: [0.5, 0.5, 0.5], colour: r % 6 });
    return { name: 'Pyramid', bodies, camera: { eye: [9, 7, 16], target: [0, 4.5, 0], fov: 50 } };
  },
  tower: () => {
    const bodies: BodySpec[] = [ground()];
    for (let i = 0; i < 20; i++) bodies.push({ kind: 'box', dynamic: true, pos: [0, 0.5 + i * 1.0, 0], size: [0.5, 0.5, 0.5], colour: i % 6, quat: i % 2 ? [0, 0.3826834, 0, 0.9238795] : [0, 0, 0, 1] });
    return { name: 'Tower', bodies, camera: { eye: [16, 12, 25], target: [0, 10, 0], fov: 55 } };
  },
  wall: () => {
    const bodies: BodySpec[] = [ground()];
    // Running bond: odd rows have one brick fewer, offset by half a brick, so nothing overhangs.
    for (let r = 0; r < 10; r++)
      for (let i = 0; i < (r % 2 ? 9 : 10); i++) bodies.push({ kind: 'box', dynamic: true, pos: [(i - 4.5) * 1.0 + (r % 2 ? 0.5 : 0), 0.25 + r * 0.5, 0], size: [0.5, 0.25, 0.25], colour: (r + i) % 6 });
    bodies.push({ kind: 'sphere', dynamic: true, pos: [0, 2, 12], size: [0.6], vel: [0, 2, -18], density: 4000, colour: 7 });
    return { name: 'Wall and ball', bodies, camera: { eye: [12, 6, 14], target: [0, 2, 0], fov: 50 } };
  },
  pile: () => {
    const bodies: BodySpec[] = [ground(12)];
    for (const [x, z, hx, hz] of [[-6.25, 0, 0.25, 6.5], [6.25, 0, 0.25, 6.5], [0, -6.25, 6, 0.25], [0, 6.25, 6, 0.25]]) bodies.push({ kind: 'box', dynamic: false, pos: [x, 1.5, z], size: [hx, 1.5, hz] });
    let k = 0;
    for (let y = 0; y < 8; y++)
      for (let i = 0; i < 5; i++)
        for (let j = 0; j < 5; j++) {
          const p: [number, number, number] = [(i - 2) * 1.6 + (y % 2) * 0.3, 3 + y * 1.3, (j - 2) * 1.6 + (y % 2) * 0.3];
          bodies.push(k % 2 ? { kind: 'sphere', dynamic: true, pos: p, size: [0.45], colour: k % 6 } : { kind: 'box', dynamic: true, pos: p, size: [0.45, 0.45, 0.45], colour: k % 6, quat: [0.1, 0.2, 0, 0.9746794] });
          k++;
        }
    return { name: 'Pile (200 bodies)', bodies, camera: { eye: [12, 14, 16], target: [0, 1, 0], fov: 50 } };
  },
  fastball: () => {
    const bodies: BodySpec[] = [ground()];
    bodies.push({ kind: 'box', dynamic: false, pos: [0, 2, 0], size: [3, 2, 0.05] });
    // Start offset so that no step lands the ball inside the plate: it really has to be caught in flight.
    bodies.push({ kind: 'sphere', dynamic: true, pos: [0, 2, 10.37], size: [0.15], vel: [0, 0, -600], density: 7800, fast: true, colour: 2 });
    return { name: 'Fast ball and thin plate', bodies, camera: { eye: [10, 5, 10], target: [0, 2, 2], fov: 50 } };
  },
};
