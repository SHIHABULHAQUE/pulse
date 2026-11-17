import { expect, test, type Page } from '@playwright/test';

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
}

test('two people create, discover, join and chat in a room', async ({ browser }) => {
  const ana = await (await browser.newContext()).newPage();
  const ben = await (await browser.newContext()).newPage();
  await open(ana);
  await open(ben);

  // Both auto-join the lobby on first launch.
  await expect(ana.getByRole('heading', { name: 'Lobby', level: 2 })).toBeVisible();

  // Ana sets a handle.
  await ana.getByRole('button', { name: 'Settings and data' }).click();
  await ana.getByLabel('Handle').fill('ana');
  await ana.getByRole('button', { name: 'Save profile' }).click();
  await ana.getByRole('button', { name: 'Close' }).click();

  // Ana creates a room.
  await ana.getByRole('button', { name: 'Create a room' }).click();
  await ana.getByLabel('Name').fill('Kochi Coffee');
  await ana.getByLabel('Topic').fill('Filter coffee talk');
  await ana.getByRole('button', { name: 'Create room' }).click();
  await expect(ana.getByRole('heading', { name: 'Kochi Coffee', level: 2 })).toBeVisible();
  await ana.screenshot({ path: 'e2e/.results/ana-room.png' });

  // Ben finds it in the directory and joins.
  await ben.getByRole('button', { name: 'Browse rooms' }).first().click();
  await ben.getByLabel('Search rooms').fill('coffee');
  await ben.locator('.directory-item', { hasText: 'Kochi Coffee' }).getByRole('button', { name: 'Join' }).click();
  await expect(ben.getByRole('heading', { name: 'Kochi Coffee', level: 2 })).toBeVisible();

  // They chat both ways.
  await ana.getByLabel('Write a message').fill('namaskaram! ☕');
  await ana.keyboard.press('Enter');
  await expect(ben.getByRole('log').getByText('namaskaram! ☕')).toBeVisible();
  await expect(ben.getByRole('log').getByText('ana', { exact: true })).toBeVisible();
  await ben.getByLabel('Write a message').fill('hello from ben');
  await ben.getByRole('button', { name: /Send/ }).click();
  await expect(ana.getByRole('log').getByText('hello from ben')).toBeVisible();
  await expect(ana.locator('.people')).toContainText('ana (you)');
  await ben.screenshot({ path: 'e2e/.results/ben-chat.png' });

  // History survives a reload (IndexedDB) and the room is rejoined automatically.
  await ben.reload();
  await expect(ben.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  await ben.getByRole('button', { name: /Kochi Coffee/ }).click();
  await expect(ben.getByRole('log').getByText('namaskaram! ☕')).toBeVisible();
});

test('messages written offline are queued and delivered on reconnect', async ({ browser }) => {
  const ctx = await browser.newContext();
  const ana = await ctx.newPage();
  const ben = await (await browser.newContext()).newPage();
  await open(ana);
  await open(ben);

  await ctx.setOffline(true);
  await expect(ana.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible({ timeout: 15_000 });
  await ana.getByLabel('Write a message').fill('sent while offline');
  await ana.keyboard.press('Enter');
  await expect(ana.locator('.message.pending')).toContainText('sent while offline');

  await ctx.setOffline(false);
  await expect(ben.getByRole('log').getByText('sent while offline')).toBeVisible({ timeout: 20_000 });
  await expect(ana.locator('.message.pending')).toHaveCount(0);
});

test('export and re-import keeps the same identity', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Settings and data' }).click();
  const fingerprint = await page.locator('.settings code').innerText();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export my data (JSON)' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^pulse-.+-\d{4}-\d{2}-\d{2}\.json$/);
  const path = await file.path();

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Wipe this device' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings and data' }).click();
  await expect(page.locator('.settings code')).not.toHaveText(fingerprint);

  page.once('dialog', (d) => void d.accept());
  await page.locator('input[type=file]').setInputFiles(path);
  await page.waitForEvent('load');
  await page.getByRole('button', { name: 'Settings and data' }).click();
  await expect(page.locator('.settings code')).toHaveText(fingerprint);
});
