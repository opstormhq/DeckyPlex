import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

const fixtureHtml = new URL('./fixture.html', import.meta.url);
const host = fileURLToPath(new URL('./decky-host.jsx', import.meta.url));
const captureScreenshots = process.env.DECKYPLEX_CAPTURE_SCREENSHOTS === '1';
let javascript;

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./app.jsx', import.meta.url))],
    bundle: true, write: false, jsx: 'automatic', format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'decky-test-host',
      setup(builder) {
        builder.onResolve({ filter: /^(@decky\/(api|ui)|\.\.\/context\/PlayerContext)$/ }, () => ({ path: host }));
      },
    }],
  });
  javascript = bundle.outputFiles[0].text;
});

async function openFixture(page, screen, options = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://deckyplex.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/app.js') {
      await route.fulfill({ contentType: 'application/javascript', body: javascript });
    } else if (path === '/') {
      await route.fulfill({ contentType: 'text/html', body: await readFile(fixtureHtml) });
    } else {
      await route.abort();
    }
  });
  const query = new URLSearchParams({ screen, ...options });
  await page.goto(`https://deckyplex.test/?${query}`);
  return errors;
}

const actions = page => page.evaluate(() => window.fixture.actions);
const press = (page, button, repeat = false) =>
  page.evaluate(([key, repeating]) => window.fixture.press(key, repeating), [button, repeat]);

test('the library keeps top-row focus in the grid and restores the selected album from Play Artist', async ({ page }, info) => {
  await page.clock.install();
  const errors = await openFixture(page, 'browser');
  const artists = page.locator('[data-browser-tab="artists"]');
  const firstArtist = page.locator('[data-browser-item-id="artist-0"]');
  await expect(artists).toBeFocused();
  await expect(firstArtist).toBeVisible();
  await expect.poll(() => page.locator('[data-browser-card] img').evaluateAll(images =>
    images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  if (captureScreenshots) {
    await page.screenshot({ path: info.outputPath('library-browser.png'), animations: 'disabled' });
  }
  await firstArtist.focus();
  expect(await press(page, 'DIR_UP')).toBe(false);
  await expect(firstArtist).toBeFocused();

  // Reproduce navigation before the artist view's deferred focus has run.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  await firstArtist.evaluate(element => element.click());
  const secondAlbum = page.locator('[data-browser-item-id="album-1"]');
  const playArtist = page.locator('[data-browser-play-collection]');
  await expect(secondAlbum).toBeVisible();
  await secondAlbum.focus();
  await press(page, 'DIR_UP');
  await expect(playArtist).toBeFocused();
  await page.clock.runFor(48);
  await expect(playArtist).toBeFocused();
  await press(page, 'DIR_DOWN');
  await expect(secondAlbum).toBeFocused();
  await page.clock.resume();
  await page.keyboard.press('Escape');
  await expect(firstArtist).toBeFocused();
  await firstArtist.click();
  await expect(page.locator('[data-browser-item-id="album-0"]')).toBeFocused();
  expect(errors).toEqual([]);
});

test('a pending page cannot replace artist details and appears after returning to the grid', async ({ page }) => {
  const errors = await openFixture(page, 'browser', { pagination: 'delayed' });
  const firstArtist = page.locator('[data-browser-item-id="artist-0"]');
  const finalArtist = page.locator('[data-browser-item-id="artist-11"]');
  await finalArtist.focus();
  await expect.poll(async () => (await actions(page)).some(([method, section, type, , offset]) =>
    method === 'get_section_contents' && section === '1' && type === 'artist' && offset === 12)).toBe(true);
  await firstArtist.click();
  await expect(page.locator('[data-browser-item-id="album-0"]')).toBeVisible();
  await page.evaluate(() => window.fixture.finishPage());
  await expect(page.locator('[data-browser-item-id="artist-12"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-browser-item-id="artist-12"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the bottom sidebar entry remains in view and blocks downward navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 480 });
  const errors = await openFixture(page, 'browser');
  const search = page.locator('[data-browser-tab="search"]');
  await expect(page.locator('[data-browser-item-id="artist-0"]')).toBeVisible();
  await search.focus();
  await expect(search).toBeInViewport({ ratio: 1 });
  expect(await press(page, 'DIR_DOWN')).toBe(false);
  await expect(search).toBeFocused();
  expect(errors).toEqual([]);
});

test('Start focuses the search box after loading, and a failed search leaves the form usable', async ({ page }) => {
  const errors = await openFixture(page, 'browser');
  await expect(page.locator('[data-browser-tab="artists"]')).toBeFocused();
  await press(page, 'START');
  const search = page.getByPlaceholder('Search your Plex libraries…');
  await expect(search).toBeFocused();
  await search.fill('missing title');
  await search.press('Enter');
  await expect(page.getByText('No results found.')).toBeVisible();
  await expect(search).toHaveValue('missing title');
  await search.fill('Blue Atlas');
  await search.press('Enter');
  await expect(page.locator('[data-browser-item-id="artist-1"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('Blue Atlas');
  const searches = (await actions(page)).filter(([method]) => method === 'search_library');
  expect(searches.map(([, query]) => query)).toEqual(['missing title', 'Blue Atlas']);
  expect(errors).toEqual([]);
});

test('Quick View collapses a focused queue, goes to Browse, then closes the tray on B', async ({ page }, info) => {
  await page.setViewportSize({ width: 440, height: 660 });
  const errors = await openFixture(page, 'quick');
  const browse = page.getByRole('button', { name: 'Browse Media' });
  const queue = page.getByRole('button', { name: 'Queue · 1/2' });
  await expect(browse).toBeVisible();
  await queue.click();
  const secondTrack = page.getByRole('button', { name: /Evening Current/ });
  await expect(secondTrack).toBeVisible();
  await expect.poll(() => page.locator('[data-quick-artwork] img').evaluateAll(images =>
    images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  if (captureScreenshots) {
    await page.screenshot({ path: info.outputPath('quick-player.png'), animations: 'disabled' });
  }
  await secondTrack.focus();
  await press(page, 'CANCEL');
  await expect(secondTrack).toHaveCount(0);
  await expect(queue).toBeFocused();
  await press(page, 'CANCEL');
  await expect(browse).toBeFocused();
  await press(page, 'CANCEL', true);
  expect(await actions(page)).not.toContainEqual(['close tray']);
  await press(page, 'CANCEL');
  expect(await actions(page)).toContainEqual(['close tray']);
  expect(errors).toEqual([]);
});

test('signed-out Quick View provides a login shortcut and skips idle transport controls', async ({ page }) => {
  const errors = await openFixture(page, 'idle', { account: 'signed-out' });
  const login = page.getByRole('button', { name: 'Log in' });
  await expect(login).toBeEnabled();
  await expect(page.getByText('Nothing playing')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await login.click();
  expect((await actions(page)).map(([name]) => name)).toContain('login');
  expect(errors).toEqual([]);
});

test('light Quick View exposes video actions and keeps content within the tray width', async ({ page }, info) => {
  await page.setViewportSize({ width: 440, height: 660 });
  const errors = await openFixture(page, 'video', { theme: 'light' });
  const fullscreen = page.getByRole('button', { name: 'Full screen' });
  const popout = page.getByRole('button', { name: 'Pop out' });
  await expect(page.locator('[data-deckyplex-quick-player][data-deckyplex-light]')).toBeVisible();
  await expect(fullscreen).toBeEnabled();
  await expect(popout).toBeEnabled();
  const left = await fullscreen.boundingBox();
  const right = await popout.boundingBox();
  expect(left.y).toBeCloseTo(right.y);
  expect(left.x + left.width).toBeLessThan(right.x);
  expect(right.x + right.width).toBeLessThanOrEqual(440);
  if (captureScreenshots) {
    await page.screenshot({ path: info.outputPath('quick-video-light.png'), animations: 'disabled' });
  }
  await fullscreen.click();
  await popout.click();
  expect(await actions(page)).toEqual(expect.arrayContaining([['fullscreen'], ['pop out']]));
  expect(errors).toEqual([]);
});

test('the scrubber moves a visible draft and sends one seek after confirmation', async ({ page }) => {
  const errors = await openFixture(page, 'scrubber');
  const scrubber = page.getByRole('button', { name: /Playback position/ });
  await scrubber.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Next control' })).toBeFocused();
  await scrubber.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(scrubber).toHaveAccessibleName('Playback position 1:50 of 10:00');
  expect(await actions(page)).not.toContainEqual(['seek', 110]);
  await page.keyboard.press('Escape');
  await expect(scrubber).toHaveAccessibleName('Playback position 1:40 of 10:00');
  await scrubber.press('Enter');
  await page.keyboard.press('ArrowRight');
  await scrubber.press('Enter');
  expect((await actions(page)).filter(([name]) => name === 'seek')).toEqual([['seek', 105]]);
  await expect(scrubber).toHaveAccessibleName('Playback position 1:45 of 10:00');
  expect(errors).toEqual([]);
});

test('Players scrolls the help and discovery status above the footer when Refresh players has focus', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 340 });
  const errors = await openFixture(page, 'settings', { account: 'signed-out' });
  await page.getByRole('tab', { name: 'Players' }).click();
  const refresh = page.getByRole('button', { name: 'Refresh players' });
  const help = page.getByText('Connect a Plex server in Advanced to send music from your library.');
  await expect(refresh).toBeEnabled();
  await refresh.focus();
  await expect(refresh).toBeFocused();
  const bottomClearance = locator => locator.evaluate(element => {
    const panel = element.closest('[role="tabpanel"]');
    return panel.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
  });
  await expect.poll(() => bottomClearance(help)).toBeGreaterThan(65);
  await refresh.press('Enter');
  const status = page.getByRole('status').filter({ hasText: 'No Plex players found.' });
  await expect.poll(() => bottomClearance(status)).toBeGreaterThan(65);
  expect(errors).toEqual([]);
});

test('Advanced skips Connect until a local address exists and opens a music-first library picker', async ({ page }) => {
  const errors = await openFixture(page, 'settings', { account: 'signed-out' });
  await page.getByRole('tab', { name: 'Advanced' }).click();
  const address = page.getByRole('textbox', { name: /Local Plex server address/ });
  const connect = page.getByRole('button', { name: 'Connect', exact: true });
  await expect(connect).toHaveCount(0);
  await address.press('Tab');
  await expect(page.getByRole('slider', { name: 'Connection timeout: 8s' })).toBeFocused();
  await address.fill('   ');
  await expect(connect).toHaveCount(0);
  await address.fill('test.invalid:32400');
  await address.press('Tab');
  await expect(connect).toBeFocused();
  await address.press('Enter');

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Choose Plex libraries')).toBeVisible();
  await expect(dialog.getByRole('switch', { name: /Music/ })).toBeChecked();
  await expect(dialog.getByRole('switch', { name: /Movies/ })).not.toBeChecked();
  await dialog.getByText('Continue', { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await actions(page)).toEqual(expect.arrayContaining([
    ['connect_local_server', 'test.invalid:32400'],
    ['set_library_selection', 'fixture', ['1'], false],
  ]));
  await expect(connect).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('Advanced places Test connection directly after the signed-in address override', async ({ page }) => {
  const override = 'http://test.invalid:32400';
  const errors = await openFixture(page, 'settings', { override });
  await page.getByRole('tab', { name: 'Advanced' }).click();
  const address = page.getByRole('textbox', { name: /Plex server address override/ });
  const check = page.getByRole('button', { name: 'Test connection' });
  await expect(address).toHaveValue(override);
  await address.press('Tab');
  await expect(check).toBeFocused();
  await check.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Connected to Test Plex.' })).toBeVisible();
  expect(await actions(page)).toContainEqual(['validate_connection']);
  expect(errors).toEqual([]);
});
