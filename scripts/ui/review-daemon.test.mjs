import test from 'node:test';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

async function fixture(port, mode='ready', fragmented=false) {
 const root=mkdtempSync(join(tmpdir(),'stage-contract-'));
 for(const dir of ['scripts/ui','e2e/lib','target/release','bin','tmp']) mkdirSync(join(root,dir),{recursive:true});
 const stage=readFileSync(new URL('./review-daemon.sh',import.meta.url),'utf8');
 const marker='echo "UX_STAGE_READY"';
 assert.ok(stage.includes(marker));
 // stdout may deliver readiness before its following credential-path line.
 writeFileSync(join(root,'scripts/ui/review-daemon.sh'),fragmented?stage.replace(marker,marker+'\n/bin/sleep 0.08'):stage);
 writeFileSync(join(root,'e2e/lib/ux-fixture.mjs'),'');
 const executable=(path,text)=>writeFileSync(join(root,path),text,{mode:0o755});
 executable('target/release/omp-pulse',`#!/bin/sh
printf '%s\\n' "$HERDR_PANE_ID|$HERDR_SOCKET_PATH|$HERDR_TAB_ID|$KITTY_LISTEN_ON|$KITTY_WINDOW_ID|$TMUX|$TMUX_PANE" > "$PROBE_ROOT/identities"
printf '%s\\n' "$HERDR_SESSION" "$HERDR_CONFIG_PATH" "$OMP_PULSE_STATE_DIR" "$OMP_REMOTE_SESSIONS_ROOT" > "$PROBE_ROOT/paths"
if [ "$PROBE_MODE" = die ]; then exit 3; fi
trap 'exit 0' TERM INT
while :; do sleep 0.05; done
`);
 executable('bin/curl',`#!/bin/sh
if [ ! -f "$PROBE_ROOT/curl-probed" ]; then touch "$PROBE_ROOT/curl-probed"; exit 1; fi
[ "$PROBE_MODE" = ready ]
`);
 executable('bin/herdr',`#!/bin/sh
printf '%s\\n' "$*" >> "$PROBE_ROOT/herdr-calls"
`);
 // Speed timeout fixtures without altering the stage's readiness logic.
 executable('bin/sleep','#!/bin/sh\n/bin/sleep 0.005\n');
 const env={...process.env,PATH:`${root}/bin:${process.env.PATH}`,TMPDIR:`${root}/tmp`,PROBE_ROOT:root,PROBE_MODE:mode,OMP_PULSE_UX_PORT:port,OMP_PULSE_UX_TOKEN:randomBytes(24).toString('hex')};
 for(const key of ['HERDR_PANE_ID','HERDR_SOCKET_PATH','HERDR_TAB_ID','KITTY_LISTEN_ON','KITTY_WINDOW_ID','TMUX','TMUX_PANE'])env[key]='must-not-inherit';
 const child=spawn('bash',[join(root,'scripts/ui/review-daemon.sh')],{env});let output='',error='';
 child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{error+=data;});
 const ended=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));
 // Only a backstop for a stage that never exits. At 4 s it fired during the stage's
 // own cleanup when the gate ran test files in parallel: cleanup resets the TERM trap,
 // so that TERM killed bash before `rm -rf "$TMP"` and the state-dir check failed.
 const timer=setTimeout(()=>child.kill('SIGTERM'),20000);
 try {
   if(mode==='ready'&&!['7682','07682','0','65536','oops'].includes(port)) {
     const complete=()=>output.includes('UX_STAGE_READY')&&/credential file: [^\r\n]+\r?\n/.test(output);
     for(let n=0;n<300&&!complete();n++)await new Promise(r=>setTimeout(r,10));
     assert.match(output,/UX_STAGE_READY/);
     assert.equal(readFileSync(join(root,'identities'),'utf8').trim(),'||||||');
     const paths=readFileSync(join(root,'paths'),'utf8').trim().split('\n');
     assert.match(paths[0],/^omp-pulse-ux-/);
     assert.ok(paths.slice(1).every(path=>path.startsWith(root+'/tmp/')));
     const tokenFile=output.match(/credential file: ([^\r\n]+)\r?\n/)?.[1];assert.ok(tokenFile);
     assert.equal(statSync(tokenFile).mode&0o777,0o600);
     assert.ok(!output.includes(env.OMP_PULSE_UX_TOKEN));
     child.kill('SIGTERM');
   }
   const result=await ended;
   assert.ok(!output.includes(env.OMP_PULSE_UX_TOKEN));
   if(mode!=='ready'||['7682','07682','0','65536','oops'].includes(port)){assert.notEqual(result.code,0);assert.ok(!output.includes('UX_STAGE_READY'));}
   if(existsSync(join(root,'paths'))) {
     const paths=readFileSync(join(root,'paths'),'utf8').trim().split('\n');
     assert.equal(existsSync(paths[2]),false);
     const calls=readFileSync(join(root,'herdr-calls'),'utf8');
     assert.ok(calls.split('\n').filter(Boolean).every(line=>line.endsWith(paths[0])));
   }
   return {output,error,result};
 } finally { clearTimeout(timer);child.kill('SIGTERM');rmSync(root,{recursive:true,force:true}); }
}

test('stage isolates identities and keeps credentials out of output',()=>fixture('7690'));
test('stage accepts readiness and credential path arriving in separate chunks',()=>fixture('7690','ready',true));
for(const port of ['7682','07682','0','65536','oops'])test(`stage rejects port ${port}`,()=>fixture(port));
test('stage never claims readiness after a timeout',()=>fixture('7690','timeout'));
test('stage never claims readiness after daemon death',()=>fixture('7690','die'));
