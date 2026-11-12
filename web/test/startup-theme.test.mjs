import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root=new URL('../../',import.meta.url);
const html=await readFile(new URL('web/index.html',root),'utf8');
const css=await readFile(new URL('web/src/styles.css',root),'utf8');
const manifest=JSON.parse(await readFile(new URL('web/public/manifest.webmanifest',root),'utf8'));

// Standard OKLab to linear-sRGB transform, then the sRGB transfer function.
// This is a token consistency check, not rendered contrast/colour evidence.
function srgbHex(L,C,h) {
  const a=C*Math.cos(h*Math.PI/180),b=C*Math.sin(h*Math.PI/180);
  const l=(L+.3963377774*a+.2158037573*b)**3;
  const m=(L-.1055613458*a-.0638541728*b)**3;
  const s=(L-.0894841775*a-1.291485548*b)**3;
  return '#'+[
    4.0767416621*l-3.3077115913*m+.2309699292*s,
    -1.2684380046*l+2.6097574011*m-.3413193965*s,
    -.0041960863*l-.7034186147*m+1.707614701*s,
  ].map(c=>Math.round(255*Math.max(0,Math.min(1,c<=.0031308?12.92*c:1.055*c**(1/2.4)-.055))).toString(16).padStart(2,'0')).join('');
}
const token=name=>css.match(new RegExp('--'+name+': (oklch\\(([^)]+)\\));'));

test('startup page and placeholder surfaces match loaded semantic tokens',()=>{
    assert.ok(html.includes('background: '+token('background')[1]+';'));
  assert.ok(html.includes('background: '+token('surface-1')[1]+';'));
});
test('browser chrome and installed-app background match the nearest sRGB page colour',()=>{
  const expected=srgbHex(...token('background')[2].split(/\s+/).map(Number));
  assert.ok(html.includes('html { background: '+expected+'; background:'));
  assert.match(html,new RegExp('<meta name="theme-color" content="'+expected+'"'));
  assert.equal(manifest.theme_color,expected);
  assert.equal(manifest.background_color,expected);
});
test('boot script and skeleton colours for Dim and Grey match the loaded tokens',()=>{
  for (const name of ['dim','grey']) {
    const block=css.match(new RegExp('html\\[data-background="'+name+'"\\],\\s*html\\[data-background="'+name+'"\\] \\.dark \\{([^}]+)\\}'))[1];
    const [bg,s1]=['background','surface-1'].map(n=>block.match(new RegExp('--'+n+': oklch\\(([^)]+)\\)'))[1]);
    const hex=srgbHex(...bg.split(/\s+/).map(Number));
    assert.ok(html.includes('html[data-background="'+name+'"] { background: '+hex+'; background: oklch('+bg+'); }'));
    assert.ok(html.includes('html[data-background="'+name+'"] .boot i { background: oklch('+s1+'); }'));
    assert.ok(html.includes('"'+hex+'"'));
  }
});
test('startup controls use compact geometry without animating or becoming interactive',()=>{
  assert.match(html,/\.boot \.b \{ width: 44px; height: 44px; border-radius: 8px;/);
  assert.match(html,/\.boot \.s \{ height: 44px;[^}]+border-radius: 8px;/);
  const boot=html.slice(html.indexOf('<div id="root">'),html.indexOf('<script type="module"'));
  assert.match(boot,/aria-busy="true" aria-label="Loading"/);
  assert.doesNotMatch(boot,/<(?:button|input|a)\b|tabindex|onclick/i);
  assert.doesNotMatch(html.slice(html.indexOf('<style>'),html.indexOf('</style>')),/animation|transition|url\(/);
  assert.equal((html.match(/<script\b/g)||[]).length,2,'the module entry plus the synchronous boot-appearance script');
});
