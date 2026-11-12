import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

// One integrator now serves the drawer, the sheets, the selection indicator
// and the progress bars. These pin the properties the UI relies on: it lands
// exactly on the target, critically damped motion never goes past it, a
// release velocity is carried (so a handed-off gesture does not stall), and
// the CSS form is a valid sampled `linear()` curve.
const code = await bundleDomFixture(`
 import * as motion from ${JSON.stringify(resolve(root, "web/src/app/ui/motion.ts"))};
 window.motion = motion;
`);

test("critical damping never overshoots; a released velocity is carried", (t) => {
  const dom = createDomFixture(code);
  t.after(() => dom.close());
  const { springFrames, POSITION } = dom.window.motion;
  const frames = springFrames(0, 100, 0, POSITION);
  assert.equal(frames[0].x, 0);
  assert.equal(frames[frames.length - 1].x, 100);
  for (const frame of frames) assert.ok(frame.x <= 100 + 1e-9, `overshoot at ${frame.ms}ms: ${frame.x}`);
  assert.ok(frames[frames.length - 1].ms <= 400, "settles inside 400ms");

  const carried = springFrames(0, 100, 2, POSITION); // 2 px/ms toward the target
  const at16 = carried.find((frame) => frame.ms === 16).x;
  const still = springFrames(0, 100, 0, POSITION).find((frame) => frame.ms === 16).x;
  assert.ok(at16 > still, "the release velocity moves it further, sooner");
});

test("a short distance settles sooner than the whole duration", (t) => {
  const dom = createDomFixture(code);
  t.after(() => dom.close());
  const { springFrames, POSITION } = dom.window.motion;
  const long = springFrames(0, 300, 0, POSITION);
  const short = springFrames(0, 12, 0, POSITION);
  assert.ok(short[short.length - 1].ms < long[long.length - 1].ms);
});

test("the CSS form is a sampled linear() curve from 0% to 100%", (t) => {
  const dom = createDomFixture(code);
  t.after(() => dom.close());
  const { springEasing, SETTLE } = dom.window.motion;
  const { easing, duration } = springEasing(SETTLE);
  assert.match(easing, /^linear\(0 0%/);
  assert.match(easing, /1 100%\)$/);
  assert.ok(duration >= 100 && duration <= 400, `duration ${duration}`);
  const offsets = [...easing.matchAll(/([\d.]+)%/g)].map((m) => Number(m[1]));
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] >= offsets[i - 1], "offsets never go backwards");
});
