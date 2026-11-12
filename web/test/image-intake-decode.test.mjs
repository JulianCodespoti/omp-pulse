import test from 'node:test';
import assert from 'node:assert/strict';

// No real decoder or canvas in node: the browser pieces are models. What this
// pins is how intake reacts to a decode failure and to an oversize PNG encode.
const {intakeFiles,MAX_IMAGE_BASE64_CHARS}=await import('../src/app/composer/image-intake.ts');

let decodable=true,pngChars=0;
globalThis.URL.createObjectURL=()=>'blob:synthetic';
globalThis.URL.revokeObjectURL=()=>{};
globalThis.Image=class{
  naturalWidth=1200;naturalHeight=900;onload=null;onerror=null;
  set src(_){queueMicrotask(()=>decodable?this.onload():this.onerror())}
};
globalThis.document={createElement:()=>({
  width:0,height:0,
  getContext:()=>({drawImage(){}}),
  toDataURL:type=>`data:${type};base64,${'a'.repeat(type==='image/png'?pngChars:1000)}`,
})};
const file=(name,type)=>({name,type});

test('an image the WebView cannot decode names the file and what to attach instead',async()=>{
  decodable=false;
  const result=await intakeFiles([file('IMG_0042.HEIC','image/heic')],0);
  decodable=true;
  assert.equal(result.images.length,0);
  assert.equal(result.error,'Couldn’t open IMG_0042.HEIC. Try a JPEG or PNG instead.');
});

test('a PNG photo over the byte cap is attached as JPEG instead of refused',async()=>{
  pngChars=MAX_IMAGE_BASE64_CHARS+1;
  const result=await intakeFiles([file('scan.png','image/png')],0);
  assert.equal(result.error,undefined);
  assert.equal(result.images.length,1);
  assert.equal(result.images[0].mimeType,'image/jpeg');
  assert.equal(result.images[0].data.length,1000);
});

test('a PNG under the byte cap stays PNG',async()=>{
  pngChars=10;
  const result=await intakeFiles([file('icon.png','image/png')],0);
  assert.equal(result.images[0].mimeType,'image/png');
});
