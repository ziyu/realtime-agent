import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test.beforeEach(async({request})=>{const b=await(await request.get('/api/bootstrap')).json();expect(b.state.mode).toBe('demo');const headers={'X-RA-Token':b.token};await request.post('/api/control',{headers,data:{action:'reset'}});await request.post('/api/control',{headers,data:{action:'resume'}})});

test('desktop: real 3D, instructions, Jev-gated reflection, settings and pause',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');await expect(page.locator('#connection')).toContainText('已连接');await expect(page.getByTestId('world-canvas')).toBeVisible();await page.waitForTimeout(1800);
  mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/desktop.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole('button',{name:'12 个交互对象'}).click();await expect(page.locator('[data-object]')).toHaveCount(12);await page.locator('[data-object="sink"]').click();await page.locator('[data-action="drink"]').click();
  await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).agent.action?.id).toBe('drink');
  await page.locator('#message-input').fill('不要喝水了，去读书。');await page.locator('#message-input').press('Enter');
  await expect.poll(async()=>(await(await page.request.get('/api/state')).json()).agent.action?.id).toBe('read');
  await page.locator('#message-input').fill('记住：我喜欢安静。');await page.locator('#message-input').press('Enter');await expect.poll(async()=>{const s=await(await page.request.get('/api/state')).json();return s.memories.some((m:{sourceMessageId:string})=>m.sourceMessageId===s.request?.id)},{timeout:12000}).toBe(true);
  await page.locator('[data-tab="memory"]').click();await expect(page.locator('#memory-panel')).toContainText('我喜欢安静');await page.locator('#trace-open').click();await expect(page.locator('#trace-panel')).toContainText('由快系统发起慢思考');
  await page.locator('#pause').click();await expect(page.locator('#run-label')).toHaveText('已暂停');const before=(await(await page.request.get('/api/state')).json()).clock;await page.waitForTimeout(250);const after=(await(await page.request.get('/api/state')).json()).clock;expect(after).toBe(before);
  await page.locator('#settings-open').click();await expect(page.locator('#settings-dialog')).toBeVisible();await expect(page.locator('#jev-model')).toHaveValue('jev-latest');await expect(page.locator('#jev-key')).toHaveValue('');await page.locator('#settings-dialog .dialog-close').click();expect(errors).toEqual([]);
});

test('mobile: readable 390px layout, interactive furniture and usable composer',async({page})=>{
  await page.setViewportSize({width:390,height:844});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');await expect(page.getByTestId('world-canvas')).toBeVisible();await page.waitForTimeout(1000);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await expect(page.locator('h1')).toBeVisible();expect((await page.locator('.world-card').boundingBox())!.width).toBeGreaterThan(340);
  await page.locator('#settings-open').click();expect((await page.locator('#settings-dialog').boundingBox())!.width).toBeLessThan(391);await page.locator('#settings-dialog .dialog-close').click();
  await page.locator('[data-tab="chat"]').click();await page.locator('#message-input').fill('去花园坐坐');await page.locator('#send').click();await expect(page.locator('#messages')).toContainText('去花园坐坐');await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-results/mobile.png',fullPage:true});expect(errors).toEqual([]);
});
