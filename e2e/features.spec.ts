import { expect, test, type Browser, type Page } from '@playwright/test';

async function person(browser: Browser, handle: string): Promise<{ page: Page; sent: string[] }> {
  const page = await (await browser.newContext()).newPage();
  const sent: string[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => sent.push(String(f.payload))));
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings and data' }).click();
  await page.getByLabel('Handle').fill(handle);
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  return { page, sent };
}

async function pngBase64(page: Page): Promise<string> {
  return page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 200;
    const g = c.getContext('2d')!;
    g.fillStyle = '#2b8a3e'; g.fillRect(0, 0, 320, 200);
    g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText('Kochi', 90, 115);
    return c.toDataURL('image/png').split(',')[1];
  });
}

test('password-protected room: wrong password refused, right one joins, server never sees plaintext', async ({ browser }) => {
  const ana = await person(browser, 'ana');
  const ben = await person(browser, 'ben');

  await ana.page.getByRole('button', { name: 'Create a room' }).click();
  await ana.page.getByLabel('Name').fill('Family');
  await ana.page.getByText('🔒 Password protected').click();
  await ana.page.getByLabel('Room password').fill('kochi-2026');
  await ana.page.getByRole('button', { name: 'Create room' }).click();
  await expect(ana.page.getByRole('heading', { name: 'Family', level: 2 })).toBeVisible();
  await expect(ana.page.getByText('🔒 END-TO-END ENCRYPTED')).toBeVisible();

  await ben.page.getByRole('button', { name: 'Browse rooms' }).first().click();
  const item = ben.page.locator('.directory-item', { hasText: 'Family' });
  await expect(item).toContainText('end-to-end encrypted');
  await item.getByRole('button', { name: 'Enter password' }).click();
  await item.getByLabel('Password for Family').fill('wrong-pass');
  await item.getByRole('button', { name: 'Unlock' }).click();
  await expect(ben.page.getByRole('alert').filter({ hasText: 'Wrong password' })).toBeVisible();
  await item.getByLabel('Password for Family').fill('kochi-2026');
  await item.getByRole('button', { name: 'Unlock' }).click();
  await expect(ben.page.getByRole('heading', { name: 'Family', level: 2 })).toBeVisible();

  await ana.page.getByLabel('Write a message').fill('the secret recipe is cardamom');
  await ana.page.keyboard.press('Enter');
  await expect(ben.page.getByRole('log').getByText('the secret recipe is cardamom')).toBeVisible();
  // The plaintext never went over the wire, and neither did the password.
  expect(ana.sent.join('\n')).not.toContain('cardamom');
  expect(ana.sent.join('\n')).not.toContain('kochi-2026');
  expect(ben.sent.join('\n')).not.toContain('kochi-2026');
  await ben.page.screenshot({ path: 'e2e/.results/locked-room.png' });
});

test('image sending: compressed, delivered, blurred until tapped', async ({ browser }) => {
  const ana = await person(browser, 'ana');
  const ben = await person(browser, 'ben');
  const b64 = await pngBase64(ana.page);
  await ana.page.locator('input[type=file][accept="image/*"]').setInputFiles({ name: 'kochi.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
  await expect(ana.page.getByText('Image ready')).toBeVisible();
  await ana.page.getByLabel('Write a message').fill('sunset at fort kochi');
  await ana.page.keyboard.press('Enter');

  const img = ben.page.locator('.image-message');
  await expect(img).toBeVisible();
  await expect(img).toHaveClass(/blurred/);
  await expect(ben.page.getByText('Tap to show image')).toBeVisible();
  await img.click();
  await expect(img).not.toHaveClass(/blurred/);
  // Re-encoded as WebP on the sender's device.
  expect(await img.locator('img').getAttribute('src')).toMatch(/^data:image\/(webp|jpeg);base64,/);
  await expect(ana.page.locator('.image-message')).not.toHaveClass(/blurred/); // your own images aren't blurred
  await ben.page.screenshot({ path: 'e2e/.results/image.png' });
});

test('group voice: two people connect peer-to-peer and hear each other', async ({ browser }) => {
  const ana = await person(browser, 'ana');
  const ben = await person(browser, 'ben');
  // A fresh voice room so the test is isolated from anything else in the Lobby.
  const name = 'Voice ' + Date.now();
  await ana.page.getByRole('button', { name: 'Create a room' }).click();
  await ana.page.getByLabel('Name').fill(name);
  await ana.page.getByRole('button', { name: 'Create room' }).click();
  await ben.page.getByRole('button', { name: 'Browse rooms' }).first().click();
  await ben.page.locator('.directory-item', { hasText: name }).getByRole('button', { name: 'Join' }).click();
  await expect(ben.page.getByRole('heading', { name, level: 2 })).toBeVisible();
  await ana.page.getByRole('button', { name: '🎙 Join voice' }).click();
  await expect(ben.page.locator('.voice-bar')).toContainText('1 in voice');
  await ben.page.getByRole('button', { name: '🎙 Join voice' }).click();
  await expect(ana.page.locator('.voice-bar')).toContainText('2 in voice');

  const connected = (p: Page) => p.evaluate(() => Object.values((globalThis as unknown as { __pulseVoiceDebug: () => { peers: Record<string, string> } }).__pulseVoiceDebug().peers));
  await expect.poll(() => connected(ana.page), { timeout: 20_000 }).toEqual(['connected']);
  await expect.poll(() => connected(ben.page), { timeout: 20_000 }).toEqual(['connected']);
  // Chrome's fake microphone plays a tone: ben's avatar lights up on ana's screen → audio is flowing.
  await expect(ana.page.locator('.voice-person.speaking', { hasText: 'ben' })).toBeVisible({ timeout: 15_000 });

  await ben.page.getByRole('button', { name: '🎙 Mute' }).click();
  await expect(ana.page.locator('.voice-person', { hasText: 'ben' })).toContainText('🔇');
  await ana.page.screenshot({ path: 'e2e/.results/voice.png' });

  await ben.page.getByRole('button', { name: 'Leave voice' }).click();
  await expect(ana.page.locator('.voice-bar')).toContainText('1 in voice');
  await expect.poll(() => connected(ana.page)).toEqual([]);
});

test('private room: hidden from the directory, joined by invite link, key never sent to the server', async ({ browser }) => {
  const ana = await person(browser, 'ana');
  const ben = await person(browser, 'ben');
  const eve = await person(browser, 'eve');

  await ana.page.getByRole('button', { name: 'Create a room' }).click();
  await ana.page.getByLabel('Name').fill('Kochi Family');
  await ana.page.getByText('🔐 Private (invite link)').click();
  await ana.page.getByRole('button', { name: 'Create room' }).click();

  // The invite dialog opens straight away with a link and a QR code.
  const dialog = ana.page.getByRole('dialog', { name: 'Invite to Kochi Family' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('img', { name: 'QR code for the invite link' })).toBeVisible();
  const link = await dialog.getByLabel('Invite link').inputValue();
  expect(link).toMatch(/^http:\/\/localhost:8788\/#join=kochi-family-[a-f0-9]{6}\.[\w-]+\.[\w-]{43}$/);
  const secret = link.split('.').pop()!;
  await ana.page.screenshot({ path: 'e2e/.results/invite.png' });
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(ana.page.getByText('🔐 PRIVATE · END-TO-END ENCRYPTED')).toBeVisible();

  // Eve (no link) can't find it.
  await eve.page.getByRole('button', { name: 'Browse rooms' }).first().click();
  await eve.page.getByLabel('Search rooms').fill('Kochi Family');
  await expect(eve.page.locator('.directory-item', { hasText: 'Kochi Family' })).toHaveCount(0);
  await expect(eve.page.getByText('No rooms match.')).toBeVisible();

  // Ben opens the link and lands in the room; the secret is removed from the address bar.
  await ben.page.goto(link);
  await expect(ben.page.getByRole('heading', { name: 'Kochi Family', level: 2 })).toBeVisible();
  expect(ben.page.url()).not.toContain('#join');

  await ben.page.getByLabel('Write a message').fill('hi from ben, family only');
  await ben.page.keyboard.press('Enter');
  await expect(ana.page.getByRole('log').getByText('hi from ben, family only')).toBeVisible();

  // Ben can re-share (he has the invite secret too).
  await ben.page.getByRole('button', { name: 'Invite', exact: true }).click();
  expect(await ben.page.getByLabel('Invite link').inputValue()).toBe(link);

  // Neither the secret nor the plaintext ever went over the WebSocket, and Eve never heard of the room.
  for (const who of [ana, ben]) {
    expect(who.sent.join('\n')).not.toContain(secret);
    expect(who.sent.join('\n')).not.toContain('family only');
  }
  const eveReceived = await eve.page.evaluate(() => document.body.innerText);
  expect(eveReceived).not.toContain('Kochi Family');

  // A broken link gives a clear error instead of joining.
  await eve.page.goto(link.slice(0, -4) + 'AAAA');
  await expect(eve.page.getByRole('alert').filter({ hasText: 'This invite link is not valid' })).toBeVisible();
});
