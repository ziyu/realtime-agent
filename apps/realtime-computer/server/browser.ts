import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { ActionCall } from '@realtime-agent/agent';
import { callValue } from './model.js';
import type { DocumentObservation } from './model.js';

/** Isolated local workspace driver. Model output never becomes a URL, script or arbitrary selector. */
export class BrowserDriver {
  readonly deviceSessionId = randomUUID();
  private context!: BrowserContext;
  private browser!: Browser;
  page!: Page;
  private origin: string;
  private screenshotPending: Promise<Buffer> | null = null;
  private lastImage: { data: Buffer; at: number } | null = null;
  private constructor(origin: string) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('The computer reference requires a loopback origin.');
    this.origin = url.origin;
  }
  static async open(origin: string, channel: 'chrome' | 'chromium' = 'chrome'): Promise<BrowserDriver> {
    const driver = new BrowserDriver(origin);
    driver.browser = await chromium.launch({ ...(channel === 'chrome' ? { channel: 'chrome' } : {}), headless: true });
    try {
      driver.context = await driver.browser.newContext({ viewport: { width: 1050, height: 750 }, serviceWorkers: 'block' });
      // A local reference workspace has no network dependencies. Unexpected navigation is rejected at the driver boundary.
      driver.page = await driver.context.newPage(); driver.page.setDefaultTimeout(2000);
      await driver.page.goto(`${driver.origin}/workspace`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await driver.page.locator('#record-form[data-document]:not([data-document=""])').waitFor();
      return driver;
    } catch (error) { await driver.close(); throw error; }
  }
  private checkPage(): void {
    const url = new URL(this.page.url());
    if (url.origin !== this.origin || url.pathname !== '/workspace') throw new Error('The controlled workspace changed identity.');
  }
  async capture(): Promise<DocumentObservation> {
    this.checkPage();
    const observation = await this.page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('#record-form');
      const saved = document.querySelector<HTMLElement>('#saved');
      if (!form?.dataset.document || !saved) throw new Error('Workspace is unavailable.');
      const fields = Object.fromEntries(new FormData(form)) as { name: string; category: 'work' | 'life'; note: string };
      const popup = !!document.querySelector<HTMLDialogElement>('#notice')?.open;
      const targets: Record<string, { version: number; visible: boolean; enabled: boolean; value: string }> = {};
      for (const element of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('[data-agent-target]')) {
        const box = element.getBoundingClientRect(), style = getComputedStyle(element), name = element.dataset.agentTarget!;
        targets[name] = { version: Number(element.dataset.version), visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden'
          && (name === 'dismiss' ? popup : !popup), enabled: !element.disabled && !element.closest('[inert]'), value: 'value' in element ? element.value : '' };
      }
      const saveVersion = Number(saved.dataset.version);
      return { documentId: form.dataset.document, capturedAt: Date.now(), layout: Number(form.dataset.layout), popup,
        saving: form.dataset.saving === 'true', fields, targets, saveVersion,
        saved: saveVersion ? {
          name: saved.querySelector('[data-saved="name"]')?.textContent ?? '',
          category: (saved.querySelector('[data-saved="category"]')?.textContent ?? '') as 'work' | 'life',
          note: saved.querySelector('[data-saved="note"]')?.textContent ?? '',
        } : null };
    });
    return { ...observation, id: randomUUID() };
  }
  /** Uses a version-bound locator and fresh actionability checks, not stored screen coordinates. */
  async execute(call: ActionCall, expected: DocumentObservation, signal: AbortSignal, onIssued: () => void = () => {}): Promise<DocumentObservation> {
    signal.throwIfAborted(); this.checkPage();
    const target = call.target;
    if (!target || !['name', 'category', 'note', 'save', 'dismiss'].includes(target)) throw new Error('Unknown workspace target.');
    const fresh = await this.capture(), current = fresh.targets[target], prior = expected.targets[target];
    signal.throwIfAborted();
    if (fresh.documentId !== expected.documentId || !current || !prior || current.version !== prior.version || !current.visible || !current.enabled
      || fresh.saving || fresh.popup && target !== 'dismiss') throw new Error('The target changed before execution.');
    const locator = this.page.locator(`[data-agent-target="${target}"][data-version="${prior.version}"]`);
    onIssued();
    if (call.capability === 'fill' && (target === 'name' || target === 'note') && callValue(call) !== null) await locator.fill(callValue(call)!);
    else if (call.capability === 'select' && target === 'category' && ['work', 'life'].includes(callValue(call) ?? '')) await locator.selectOption(callValue(call)!);
    else if (call.capability === 'click' && (target === 'save' || target === 'dismiss') && call.input === undefined) {
      await locator.click();
      if (target === 'save') await this.page.locator('#record-form[data-saving="false"]').waitFor({ timeout: 5000 });
    } else throw new Error('Unknown workspace capability.');
    // Once sent, an operation may finish despite cancellation; report the actual resulting document.
    return this.capture();
  }
  async scenario(kind: 'popup' | 'shuffle' | 'slow'): Promise<void> {
    this.checkPage();
    await this.page.locator(`[data-scenario="${kind}"]`).click();
  }
  screen(): Promise<Buffer> {
    if (this.lastImage && Date.now() - this.lastImage.at < 300) return Promise.resolve(this.lastImage.data);
    if (this.screenshotPending) return this.screenshotPending;
    this.screenshotPending = this.page.screenshot({ type: 'png', timeout: 3000 }).then(data => {
      this.lastImage = { data, at: Date.now() }; return data;
    }).finally(() => { this.screenshotPending = null; });
    return this.screenshotPending;
  }
  /** Tests/monitor pages reuse this same browser process. */
  async monitorPage(): Promise<Page> { return this.context.newPage(); }
  async close(): Promise<void> {
    try { await this.context?.close(); } finally { await this.browser?.close(); }
  }
}
