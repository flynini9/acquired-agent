import assert from 'node:assert/strict';
import {createDebouncedSave} from '../lib/acquired/debounced-save.ts';
import {fakeClock} from './helpers/reflection-save-harness.mjs';
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++};
const clock=fakeClock(),local=[],saved=[],errors=[];
const saver=createDebouncedSave({clock,local:value=>local.push(value),save:async value=>{saved.push(value);return true},failed:error=>errors.push(error)});
for(let i=1;i<=50;i++){saver.schedule('x'.repeat(i));clock.tick(10)}
eq(local.length,50);eq(saved.length,0);eq(clock.size,1);
clock.tick(689);eq(saved.length,0); // 700ms since the last key, not the first.
clock.tick(1);await saver.flush();eq(saved,['x'.repeat(50)]);
saver.schedule('blur');await Promise.all([saver.flush(),saver.flush()]);eq(saved.at(-1),'blur');eq(saved.length,2);clock.tick(1000);eq(saved.length,2);
saver.schedule('superseded');saver.schedule('latest');clock.tick(700);await saver.flush();eq(saved.at(-1),'latest');eq(saved.length,3);
saver.schedule('cancelled');saver.cancel();clock.tick(1000);eq(saved.length,3);eq(saver.hasPending(),false);
const failed=createDebouncedSave({clock,local:()=>{},save:async()=>{throw Error('transport')},failed:e=>errors.push(e.message)});
failed.schedule('dirty');eq(await failed.flush(),false);eq(errors,['transport']);clock.tick(1000);eq(errors.length,1);
console.log(`${checks} deterministic debounce checks passed; no network requests.`);
