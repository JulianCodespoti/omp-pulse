import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_APPEARANCE, PRESETS, customAccentTokens, matchingPreset, oklchToSrgb, parseAppearance, serializeAppearance } from '../src/platform/appearance.ts';
import { clockTime, messageTime } from '../src/app/clock-time.ts';

test('missing or corrupt storage reads as the pre-Appearance look', () => {
  assert.deepEqual(parseAppearance(null, null), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance('{not json', null), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance('["violet"]', null), DEFAULT_APPEARANCE);
});

test('each invalid field falls back alone; valid neighbours survive', () => {
  const parsed = parseAppearance(JSON.stringify({ accent: 'chartreuse', density: 'compact', haptics: 'no', thinking: 'latest', future: 1 }), null);
  assert.equal(parsed.accent, 'chatgpt');
  assert.equal(parsed.density, 'compact');
  assert.equal(parsed.haptics, true);
  assert.equal(parsed.thinking, 'latest');
  assert.equal('future' in parsed, false);
});

test('the legacy text-size key migrates only when Appearance has no size of its own', () => {
  assert.equal(parseAppearance(null, 'larger').textSize, 'larger');
  assert.equal(parseAppearance('{"textSize":"small"}', 'larger').textSize, 'small');
  assert.equal(parseAppearance('{"textSize":"huge"}', 'large').textSize, 'large');
  assert.equal(parseAppearance(null, 'huge').textSize, 'default');
});

test('only non-default choices are stored, and they round-trip', () => {
  assert.equal(serializeAppearance(DEFAULT_APPEARANCE), null);
  const chosen = { ...DEFAULT_APPEARANCE, streaming: 'caret', wrapCode: true, haptics: false };
  const stored = serializeAppearance(chosen);
  assert.deepEqual(JSON.parse(stored), { streaming: 'caret', wrapCode: true, haptics: false });
  assert.deepEqual(parseAppearance(stored, null), chosen);
});

// WCAG relative luminance from gamma-encoded sRGB.
const luminance = ([r, g, b]) => [r, g, b].map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const parse = (value) => { const [l, c, h] = value.match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)/).slice(1).map(Number); return oklchToSrgb(l, c, h); };

test('a custom accent of any hue stays in gamut and readable on every background', () => {
  const white = [1, 1, 1];
  // surface-3 of the Grey background is the lightest surface text sits on.
  const lightestSurface = oklchToSrgb(0.41, 0, 0);
  for (let hue = 0; hue < 360; hue += 5) {
    const tokens = customAccentTokens(hue);
    for (const key of ['primary', 'primary-text', 'dot-unread', 'accent-glow']) {
      assert.ok(parse(tokens[key]).every(x => x >= -1e-6 && x <= 1 + 1e-6), `${key} at ${hue} is out of gamut`);
    }
    assert.ok(ratio(white, parse(tokens.primary)) >= 4.5, `white on the fill at ${hue}`);
    assert.ok(ratio(parse(tokens['primary-text']), lightestSurface) >= 4.5, `accent text at ${hue}`);
  }
});

test('hues wrap and round; a preset is matched only while all its choices hold', () => {
  assert.equal(parseAppearance('{"accentHue":-30.4}', null).accentHue, 330);
  assert.equal(parseAppearance('{"accentHue":725}', null).accentHue, 5);
  assert.equal(parseAppearance('{"accentHue":"red"}', null).accentHue, DEFAULT_APPEARANCE.accentHue);
  assert.equal(matchingPreset(DEFAULT_APPEARANCE), 'chatgpt');
  const terminal = { ...DEFAULT_APPEARANCE, ...PRESETS.find(p => p.value === 'terminal').patch };
  assert.equal(matchingPreset(terminal), 'terminal');
  assert.equal(matchingPreset({ ...terminal, corners: 'round' }), null);
});

test('clock times read as a time today, a weekday this week and a date beyond', () => {
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  assert.match(clockTime(new Date(2026, 10, 4, 9, 5).getTime(), now), /09.05|9.05/);
  assert.equal(clockTime(new Date(2026, 10, 2, 9, 5).getTime(), now), new Date(2026, 10, 2).toLocaleDateString(undefined, { weekday: 'short' }));
  assert.equal(clockTime(new Date(2026, 9, 1, 9, 5).getTime(), now), new Date(2026, 9, 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
  assert.equal(clockTime(0, now), '');
});

test('message times name the day only when it is not today', () => {
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  const time = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(2026, 10, 4, 9, 5), yesterday = new Date(2026, 10, 3, 9, 5), older = new Date(2026, 9, 1, 9, 5), lastYear = new Date(2025, 9, 1, 9, 5);
  assert.equal(messageTime(today.getTime(), now), time(today));
  assert.equal(messageTime(yesterday.getTime(), now), `Yesterday ${time(yesterday)}`);
  assert.match(messageTime(older.getTime(), now), new RegExp(`, ${time(older)}$`));
  assert.match(messageTime(lastYear.getTime(), now), /2025/);
});
