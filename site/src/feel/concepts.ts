/** The feel lab's concept cards: what each group of settings does, and what to build to get it. */
import type { Term } from '../lab/learn/concepts';
import type { Settings } from './controller';

export interface FScenario {
  preset?: string;
  set?: Partial<Settings>;
  /** A named place on the course to drop the player. */
  spot?: string;
}
export interface FConcept {
  id: string;
  group: string;
  title: string;
  body: string[];
  look?: string;
  tries: Array<{ label: string; scenario: FScenario }>;
}

const MOVE = 'Moving';
const FORGIVE = 'Forgiveness';
const VIEW = 'Seeing it';

export const CONCEPTS: FConcept[] = [
  {
    id: 'feel',
    group: MOVE,
    title: 'What "feel" is made of',
    body: [
      'A character that feels good is rarely a physics simulation. It is a small state machine with a handful of numbers, each tuned so that the character does what the player meant rather than what they literally pressed. None of the settings in this lab is complicated on its own; what makes a controller feel finished is having all of them, tuned together.',
      'Every engine leaves most of this to you. A physics body with gravity gives you the "Everything off" preset: instant speed, a fixed parabola, and no mercy at ledges. The rest is a few timers and multipliers in your own controller code, whether that code sits on a character body in Godot, a script in Unity, or a component in your own engine.',
      'The way to learn it is to break it. Pick a preset, turn one setting off, and run the part of the course that tests it.',
    ],
    tries: [
      { label: 'Everything off', scenario: { preset: 'naive', spot: 'start' } },
      { label: 'Tight', scenario: { preset: 'tight', spot: 'start' } },
    ],
  },
  {
    id: 'run',
    group: MOVE,
    title: 'Acceleration, deceleration and turning',
    body: [
      'Instant speed (top speed the frame you press, zero the frame you let go) is precise and lifeless; long acceleration feels like steering a boat. Most characters land in between: a tenth of a second to top speed reads as "responsive" while still having weight. Stopping is usually faster than starting, because overshooting a ledge feels worse than a slow start.',
      'Two refinements matter more than they sound. A turnaround boost (extra acceleration when pushing against your current direction) lets the player reverse sharply without making the start feel twitchy. And air control, how much of that acceleration you keep in the air, decides whether a jump is a commitment or something you steer.',
      'To build it: store a velocity, and each tick move it towards the speed the stick asks for by at most acceleration × dt. Pick the acceleration from the time you want to reach top speed (top speed ÷ time), so designers tune in seconds rather than units per second squared.',
    ],
    look: 'the run speed line in the strip: a ramp with acceleration, a step without it.',
    tries: [
      { label: 'Instant speed', scenario: { preset: 'tight', set: { accelTime: 0, decelTime: 0 }, spot: 'run' } },
      { label: 'Half a second to top speed', scenario: { preset: 'tight', set: { accelTime: 0.5, decelTime: 0.5 }, spot: 'run' } },
      { label: 'No air control', scenario: { preset: 'tight', set: { airControl: 0 }, spot: 'steps' } },
    ],
  },
  {
    id: 'jump',
    group: MOVE,
    title: 'Jumps from height and time',
    body: [
      'Designers think in "how high" and "how long", not in gravity. Choose the jump height h and the time to the top t, and the physics follows: gravity g = 2h ÷ t² and take-off speed v = 2h ÷ t. Change the height and the jump still takes the same time; change the time and it still reaches the same height. Tuning raw gravity and jump speed instead changes both at once.',
      'Real jumps in games are rarely symmetrical. Heavier gravity on the way down (1.5 to 3 times) makes the jump feel snappy instead of floaty, and shortens the time spent drifting. A fall-speed cap keeps long drops readable. Lighter gravity right at the top while jump is held (apex hang) gives the player a moment to line up a landing.',
      'Integrate it carefully: with a fixed time step and the average of the old and new velocity for the position, a jump reaches exactly the height you set. The simplest update (add gravity to the velocity, then move by the velocity) undershoots by a little every jump.',
    ],
    look: 'the dashed path of the last jump: symmetrical with fall gravity at ×1, a steeper drop as it rises.',
    tries: [
      { label: 'Symmetrical jump', scenario: { preset: 'tight', set: { fallGravity: 1, apexHang: 1 }, spot: 'start' } },
      { label: 'Heavy fall', scenario: { preset: 'tight', set: { fallGravity: 2.8 }, spot: 'start' } },
      { label: 'Floaty', scenario: { preset: 'floaty', spot: 'start' } },
    ],
  },
  {
    id: 'variable',
    group: MOVE,
    title: 'Variable jump height',
    body: [
      'Players expect a tap to make a small hop and a held button to make a full jump. The usual way is a jump cut: the moment the button is released while still rising, multiply the upward speed by a fraction (a half is common). The jump ends early, without changing anything about a held jump.',
      'Without it, every jump is the same height, which makes small gaps and low ceilings awkward: you either bonk your head or overshoot. An alternative is to apply extra gravity while the button isn’t held, which gives a softer cut.',
    ],
    look: 'tap jump, then hold it: the strip marks each “cut short”.',
    tries: [
      { label: 'Fixed height', scenario: { preset: 'tight', set: { jumpCut: 1 }, spot: 'ceiling' } },
      { label: 'Cut to 40%', scenario: { preset: 'tight', set: { jumpCut: 0.4 }, spot: 'ceiling' } },
    ],
  },
  {
    id: 'coyote',
    group: FORGIVE,
    title: 'Coyote time',
    body: [
      'Players press jump when they *see* the edge, and by the time the press arrives the character has often walked a pixel past it. Coyote time (named after the cartoon coyote who hangs in the air until he looks down) lets a jump still work for a short moment after leaving the ground: 80 to 150 ms is typical.',
      'Turn it off and run at the gap, jumping as late as you dare: some jumps simply don’t happen, and it feels like the game ignored you. With it on, the strip shows the coyote window after each ledge, and marks the jumps it saved.',
      'To build it: keep a timer of time since you were last on the ground. Allow a jump while the timer is under the coyote time, but only if you didn’t already jump since leaving the ground, or it becomes a double jump.',
    ],
    look: 'the coyote window row after you leave a ledge, and jumps marked “coyote”.',
    tries: [
      { label: 'No coyote time', scenario: { preset: 'tight', set: { coyoteTime: 0 }, spot: 'gap' } },
      { label: '150 ms', scenario: { preset: 'tight', set: { coyoteTime: 0.15 }, spot: 'gap' } },
    ],
  },
  {
    id: 'buffer',
    group: FORGIVE,
    title: 'Jump buffering',
    body: [
      'The mirror image of coyote time. Players press jump a little before they land, expecting to jump the moment they touch down. Without a buffer, a press made 50 ms before landing does nothing, and the character lands and stands still: an "eaten" jump.',
      'A buffer remembers the press for a short window (100 to 150 ms) and fires the jump on the first frame it becomes possible. Climb the steps with the buffer off, pressing jump just before each landing, and watch the strip mark eaten presses. Turn it back on and every one becomes a jump marked “buffer”.',
      'To build it: store the time since jump was pressed, and on any tick where a jump is possible, jump if that time is under the buffer window. Clear it once used, so one press can’t jump twice.',
    ],
    look: 'presses marked “✕ eaten” with the buffer off; “buffer” jumps with it on.',
    tries: [
      { label: 'No buffer', scenario: { preset: 'tight', set: { jumpBuffer: 0 }, spot: 'steps' } },
      { label: '150 ms buffer', scenario: { preset: 'tight', set: { jumpBuffer: 0.15 }, spot: 'steps' } },
    ],
  },
  {
    id: 'corner',
    group: FORGIVE,
    title: 'Corner correction',
    body: [
      'Jump up beside a ledge and catch its corner with the edge of your head, and a plain collision stops you dead: the jump ends against a few pixels of tile the player didn’t think they touched. Corner correction checks whether a small sideways nudge would clear the ceiling, and if it would, takes the nudge and keeps the jump going.',
      'Try the low ledge: stand right under its left edge, hold right and jump. Without correction your head catches the corner and the jump dies; with it you’re nudged round the corner and land on top. The same trick applies sideways, to dash or jump onto a ledge you are a pixel too low for.',
      'To build it: when vertical movement is blocked going up, test the same move shifted a little left and right (up to a few pixels, smallest first), and accept the first one that’s clear.',
    ],
    look: '“◆ corner” marks in the strip.',
    tries: [
      { label: 'Off', scenario: { preset: 'tight', set: { cornerCorrection: 0 }, spot: 'ceiling' } },
      { label: 'On', scenario: { preset: 'tight', set: { cornerCorrection: 0.35 }, spot: 'ceiling' } },
    ],
  },
  {
    id: 'delay',
    group: FORGIVE,
    title: 'Input delay',
    body: [
      'Every frame between pressing a button and the game reacting makes a character feel heavier and less precise, even when nothing else changes. Engines add delay without anyone choosing it: input read after the simulation instead of before, an extra frame of rendering in flight, triple buffering, a TV’s processing.',
      'Set a few frames of delay and climb the steps: you start missing jumps you made easily before, and the forgiveness settings start doing more work. It’s a useful test of a controller, because players’ setups will add delay you can’t see in development.',
      'To build for it: read input as late as possible before the simulation step, keep the simulation at a fixed rate, and measure the whole chain, from button to pixel, on real hardware. The [game loops lesson](/engine/game-loops/) covers the loop itself.',
    ],
    tries: [
      { label: '6 frames of delay', scenario: { preset: 'tight', set: { inputDelay: 6 }, spot: 'steps' } },
      { label: 'No delay', scenario: { preset: 'tight', set: { inputDelay: 0 }, spot: 'steps' } },
    ],
  },
  {
    id: 'camera',
    group: VIEW,
    title: 'Camera follow, dead zones and look-ahead',
    body: [
      'A camera locked to the player shows every bump and every jump as the whole world lurching. Three settings fix most of it. **Smoothing** follows the player with a little lag: a lerp (closing a fraction of the gap each second) is simple; a critically damped spring also starts and stops smoothly, with no overshoot. A **dead zone** lets the player move a little without the camera moving at all. **Look-ahead** leads the view in the direction of travel, so players see what they’re running into.',
      'Vertically, platformers often follow the height only when the player lands, or when they fall well below the last floor. A jump then doesn’t move the view up and down, and the camera settles to the new height after each landing.',
      'Smooth with time, not frames: closing a fixed fraction of the gap each frame makes the camera slower at 30 fps than at 144. Use 1 − e^(−rate × dt), or step a spring with its exact critically damped update: a stiff spring stepped with plain Euler overshoots, and past a point blows up, even at a fixed rate.',
    ],
    look: 'tick “Show the camera’s target and dead zone” to see the box the player can move in.',
    tries: [
      { label: 'Locked on', scenario: { preset: 'tight', set: { camera: 'locked', deadZone: 0, lookAhead: 0, platformSnap: false }, spot: 'tower' } },
      { label: 'Spring, look-ahead, snapping', scenario: { preset: 'tight', spot: 'tower' } },
      { label: 'Big look-ahead on the run', scenario: { preset: 'tight', set: { lookAhead: 6 }, spot: 'run' } },
    ],
  },
  {
    id: 'juice',
    group: VIEW,
    title: 'Squash, stretch and shake',
    body: [
      '"Juice" is feedback that doesn’t change the rules: the character stretching as it leaves the ground and squashing as it lands, a screen shake on a hard landing, dust, a few frames of freeze on a heavy hit. None of it affects where the character goes, but players read it as weight and impact, and miss it when it’s gone.',
      'Two rules keep it from becoming noise. Scale it with the event (a short hop shouldn’t shake the screen; a fall down the shaft should), and make it decay quickly. Shake works best driven by a "trauma" value that events add to and time drains, with the offset proportional to trauma squared, so small bumps barely register and big ones really do.',
      'Keep it out of the simulation: apply squash to the sprite and shake to the camera offset at draw time, so gameplay, replays and networking never see it.',
    ],
    tries: [
      { label: 'Juice off, drop down the shaft', scenario: { preset: 'tight', set: { squash: false, shake: false }, spot: 'tower' } },
      { label: 'Juice on', scenario: { preset: 'tight', set: { squash: true, shake: true }, spot: 'tower' } },
    ],
  },
];

export const GLOSSARY: Record<string, Term> = {
  coyote: { term: 'Coyote time', aliases: ['coyote time'], def: 'A short window after walking off a ledge in which a jump still works.', concept: 'coyote' },
  buffer: { term: 'Jump buffer', aliases: ['jump buffer', 'buffer window'], def: 'Remembering a jump press for a short time, so a press just before landing jumps on landing.', concept: 'buffer' },
  cut: { term: 'Jump cut', aliases: ['jump cut'], def: 'Reducing upward speed when the jump button is released early, so taps make small hops.', concept: 'variable' },
  apex: { term: 'Apex hang', aliases: ['apex hang'], def: 'Lighter gravity near the top of a jump while the button is held.', concept: 'jump' },
  dead: { term: 'Dead zone', aliases: ['dead zone'], def: 'An area round the camera’s centre the player can move in without the camera following.', concept: 'camera' },
  damped: { term: 'Critically damped spring', aliases: ['critically damped spring'], def: 'A spring tuned to reach its target as fast as possible without overshooting.', concept: 'camera' },
};
