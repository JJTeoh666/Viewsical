import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {verify as controls} from './v016-native-actions.mjs';

export async function verify(args) {
  await controls(args);
  const {page,ipc,until,pass,delay}=args;
  const current=JSON.parse(await readFile(new URL('../.tools/v017-current.json',import.meta.url),'utf8'));
  const state=await ipc('player_state');
  const original=await page.locator('.full-player .player-surface').boundingBox();
  await page.evaluate(()=>{const extra=document.createElement('div');extra.id='scroll-test-spacer';extra.style.height='1500px';document.querySelector('#main-content').append(extra);window.scrollTo({top:200,behavior:'instant'});});
  await until(async()=>await ipc('plugin:window|is_visible',{label:'player-overlay'}),'partially scrolled controls remain visible');
  await delay(250);
  const {stdout}=await promisify(execFile)('python',['.tools/read-player-regions.py',String(current.pid)],{windowsHide:true});
  const regions=JSON.parse(stdout),video=regions.find(r=>r.title==='Viewsical video'),overlay=regions.find(r=>r.title==='Viewsical controls');
  assert(video&&overlay&&video.visible&&overlay.visible,JSON.stringify(regions));
  assert(video.clip[1]>0&&overlay.clip[1]>0,'both native surfaces must clip instead of hiding');
  assert.deepEqual(video.clip,overlay.clip);
  const rect=await page.locator('.full-player .player-surface').boundingBox();
  assert.equal(rect.width,original.width);assert.equal(rect.height,original.height);
  assert.equal((await ipc('player_state')).loadId,state.loadId);
  pass('partial scrolling keeps actual mpv and controls visible with matching clipped regions',{regions});
  await page.evaluate(()=>window.scrollTo({top:900,behavior:'instant'}));
  await until(async()=>!(await ipc('plugin:window|is_visible',{label:'player-overlay'})),'wholly offscreen video hides');
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  await until(()=>ipc('plugin:window|is_visible',{label:'player-overlay'}),'scroll back restores video');
  assert.equal((await ipc('player_state')).loadId,state.loadId);
  pass('scrolling away and returning restores video without a playback reload');
  await page.evaluate(()=>window.scrollTo({top:200,behavior:'instant'}));
  await delay(200);
}
