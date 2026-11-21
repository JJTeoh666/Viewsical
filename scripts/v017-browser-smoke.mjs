// Browser-only regression fixtures. Never imported by the application bundle.
import { chromium } from 'playwright';
import { preview } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'artifacts');
await mkdir(output, { recursive: true });
const server = await preview({ root, preview: { host: '127.0.0.1', port: 1423, strictPort: true } });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server', '--disable-smooth-scrolling'] });
const results = [];
const check = (name, passed, detail) => { results.push({ name, passed, detail }); if (!passed) throw new Error(name); };
const sheetRoute = '**/sb/timeline-fixture/M*.jpg';
const sheet = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><path fill="#5c85aa" d="M0 0h320v180H0z"/><path fill="#a8b98a" d="M0 90h160v90H0z"/><path fill="#d4955f" d="M160 90h160v90H160z"/></svg>';
function previewSheet(route) {
  if (route.request().url().endsWith('/M2.jpg')) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ contentType: 'image/svg+xml', body: sheet });
}
async function scrubAt(page, slider, ratio) {
  const box = await slider.boundingBox();
  const inset = await slider.evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue('--seek-thumb-size')) / 2);
  const x = box.x + inset + ratio * (box.width - 2 * inset);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  return { x, y };
}

function chapterGeometry(segments) {
  return segments.evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { left: rect.left, right: rect.right, center: rect.top + rect.height / 2, height: rect.height,
      gradient: style.backgroundImage };
  }));
}

async function railPixels(page, slider, fractions) {
  const { x, y, width, height } = await slider.boundingBox();
  const clip = { x: Math.ceil(x), y: Math.floor(y + height / 2), width: Math.floor(width) - 1, height: 1 };
  const png = await page.screenshot({ clip, scale: 'css' });
  return page.evaluate(async ({ data, fractions }) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + data;
    await image.decode();
    const context = document.createElement('canvas').getContext('2d');
    context.canvas.width = image.width;
    context.canvas.height = 1;
    context.drawImage(image, 0, 0);
    return fractions.map(fraction => Array.from(context.getImageData(Math.floor(image.width * fraction), 0, 1, 1).data));
  }, { data: png.toString('base64'), fractions });
}

async function timelineScreenshot(page, slider, filename, previewHeight) {
  const { x, y, width } = await slider.boundingBox();
  await page.screenshot({ path: path.join(output, filename),
    clip: { x: Math.floor(x - 8), y: Math.floor(y - previewHeight), width: Math.ceil(width + 16), height: previewHeight + 54 } });
}

async function thumbPosition(slider) {
  return slider.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const size = parseFloat(getComputedStyle(el).getPropertyValue('--seek-thumb-size'));
    return { x: rect.left + size / 2 + el.valueAsNumber / Number(el.max) * (rect.width - size), y: rect.top + rect.height / 2 };
  });
}

async function testNavigationLayout(page, check) {
  await page.goto('http://127.0.0.1:1423/');
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 1120, height: 680 });
  const expand = page.getByRole('button', { name: 'Expand navigation', exact: true });
  const collapse = page.getByRole('button', { name: 'Collapse navigation', exact: true });
  const sidebar = page.locator('.sidebar');
  await collapse.click();
  check('Collapsing navigation removes the sidebar and its reserved space', await sidebar.isHidden()
    && await page.locator('main').evaluate(el => getComputedStyle(el).marginLeft === '0px'));
  await expand.click();
  await sidebar.waitFor();

  await page.locator('#search').fill('piano and strings');
  await page.locator('#search').press('Enter');
  await page.locator('.result-list .video-card').last().waitFor();
  const top = page.getByRole('button', { name: 'Back to top', exact: true });
  check('Search hides Back to top before scrolling', await top.count() === 0);
  await page.evaluate(() => scrollTo(0, 700));
  await top.waitFor();
  await page.screenshot({ path: path.join(output, 'viewsical-search-back-to-top.png') });
  await top.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => scrollY < 2);
  await top.waitFor({ state: 'hidden' });
  check('Search Back to top scrolls up and focuses the results heading', await top.isHidden()
    && await page.locator('.page-heading h1').evaluate(el => el === document.activeElement));

  await page.setViewportSize(viewport);
  await page.getByRole('button', { name: 'Play Fixture video 40', exact: true }).click();
  await page.getByRole('button', { name: 'Listen with audio only', exact: true }).click();
  const surface = page.locator('.full-player .player-surface');
  const controls = surface.locator('.shared-player-controls');
  const queue = page.locator('.watch-aside');
  await surface.hover();
  check('The watch header has no inline Back button or playback status label',
    await page.locator('.watch-main .back-button, .watch-source').count() === 0);
  const minimizeButton = controls.getByRole('button', { name: 'Minimize player', exact: true });
  const enterFullscreen = controls.getByRole('button', { name: 'Fullscreen (F)', exact: true });
  await enterFullscreen.waitFor();
  check('Minimize uses a mini-player glyph and entering fullscreen has outward corners',
    await minimizeButton.locator('svg.lucide-picture-in-picture-2').isVisible()
    && await enterFullscreen.locator('svg.lucide-maximize').isVisible());
  await enterFullscreen.click();
  await page.locator('.player-fullscreen').waitFor();
  await surface.hover();
  const exitFullscreen = controls.getByRole('button', { name: 'Exit fullscreen (F)', exact: true });
  await exitFullscreen.waitFor();
  check('Fullscreen flips the icon to inward corners', await exitFullscreen.locator('svg.lucide-minimize').isVisible());
  const toolbar = await controls.locator('.right-controls').boundingBox();
  await page.screenshot({ path: path.join(output, 'viewsical-miniplayer-fullscreen-icons.png'), clip: {
    x: Math.floor(toolbar.x - 170), y: Math.floor(toolbar.y - 96), width: Math.ceil(toolbar.width + 180), height: 132,
  } });
  await exitFullscreen.click();
  await page.locator('.player-fullscreen').waitFor({ state: 'detached' });
  await surface.hover();
  await controls.getByRole('button', { name: 'Theater mode', exact: true }).click();
  const wide = await surface.boundingBox();
  check('Theater gives the player the full viewport width and hides both side panels',
    wide.x === 0 && wide.width === page.viewportSize().width && await sidebar.isHidden() && await queue.isHidden());
  await surface.hover();
  await page.screenshot({ path: path.join(output, 'viewsical-theater-full-width.png') });
  await expand.click();
  check('Expand navigation restores the sidebar and watch queue in theater',
    await sidebar.isVisible() && await queue.isVisible() && await queue.getByRole('heading', { name: 'Play queue' }).isVisible());
  await page.screenshot({ path: path.join(output, 'viewsical-theater-navigation.png') });
  await page.setViewportSize({ width: 900, height: 640 });
  const narrowSurface = await surface.boundingBox(), narrowQueue = await queue.boundingBox();
  check('Theater keeps the queue alongside the player at the minimum window width',
    narrowQueue.x > narrowSurface.x + narrowSurface.width && narrowQueue.y === narrowSurface.y);
  await page.setViewportSize(viewport);
  await collapse.click();
  await surface.hover();
  await controls.getByRole('button', { name: 'Minimize player', exact: true }).click();
  await page.locator('.result-list').waitFor();
  check('Minimizing returns to the previous search and keeps the existing video in the mini-player',
    await page.locator('.mini-player-title strong').textContent() === 'Fixture video 40'
    && await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'play_video').length === 1)
    && await sidebar.isVisible());
}

async function testCacheContent(page, check) {
  await page.getByRole('button', { name: 'Close player', exact: true }).click();
  const settings = page.locator('.sidebar-bottom').getByRole('button', { name: 'Settings', exact: true });
  await settings.click();
  const panel = page.locator('.media-cache-section');
  const content = panel.getByRole('combobox', { name: 'What to cache', exact: true });
  const toggle = panel.getByRole('switch', { name: 'Store media for replay' });
  await content.waitFor();
  check('Media cache offers both, audio only, and video only, with both selected by default',
    await content.inputValue() === 'both' && (await content.locator('option').allTextContents()).join('|') === 'Audio and video|Audio only|Video only');
  await content.selectOption('audio');
  await page.waitForFunction(() => window.__fixture.cache.content === 'audio');
  await content.selectOption('video');
  await page.waitForFunction(() => window.__fixture.cache.content === 'video');
  check('Changing cache content keeps the existing stored files and cache limit',
    await page.evaluate(() => window.__fixture.cache.entryCount === 3 && window.__fixture.cache.maxBytes === 2 * 1024 ** 3));
  await panel.screenshot({ path: path.join(output, 'viewsical-cache-content-settings.png') });
  await toggle.uncheck();
  await page.waitForFunction(() => !window.__fixture.cache.enabled);
  check('Turning off automatic caching disables the picker and remembers the choice',
    await content.isDisabled() && await content.inputValue() === 'video');
  await toggle.check();
  await page.waitForFunction(() => window.__fixture.cache.enabled);
  check('Re-enabling the cache restores the selected content', await content.inputValue() === 'video');
  await page.getByRole('button', { name: 'Downloads', exact: true }).click();
  check('Downloads displays its offline subtitle with a readable apostrophe',
    await page.getByText('Ready to watch, even when you’re offline.', { exact: true }).isVisible());
}

async function testWatchDetails(page, check) {
  const details = page.getByRole('region', { name: 'Video description' });
  const showMore = details.getByRole('button', { name: 'Show more' });
  await showMore.waitFor();
  const description = details.locator('p');
  check('Watch description shows views, a calendar date, and an excerpt', await details.getByText('49.2K views').isVisible()
    && await details.locator('time').getAttribute('datetime') === '2026-11-18'
    && (await description.textContent()).endsWith('…'));
  await page.locator('.toast').waitFor({ state: 'hidden' });
  await page.locator('.video-details').screenshot({ path: path.join(output, 'viewsical-watch-details.png') });
  await showMore.click();
  check('The full description is expandable', (await description.textContent()).endsWith('Thanks for listening.'));
  await details.getByRole('button', { name: 'Show less' }).click();

  const like = page.getByRole('button', { name: 'Like', exact: true });
  const dislike = page.getByRole('button', { name: 'Dislike', exact: true });
  await like.click();
  await page.waitForFunction(() => document.querySelector('.watch-ratings [aria-label="Like"]').getAttribute('aria-pressed') === 'true');
  await dislike.click();
  await page.waitForFunction(() => document.querySelector('.watch-ratings [aria-label="Dislike"]').getAttribute('aria-pressed') === 'true');
  await dislike.click();
  await page.waitForFunction(() => document.querySelector('.watch-ratings [aria-label="Dislike"]').getAttribute('aria-pressed') === 'false');
  const ratings = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'rate_video').map(call => call.args.rating));
  check('Signed-in viewers can like, switch to dislike, and clear a vote', ratings.join(',') === 'like,dislike,none');

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => window.__fixture.setPlaybackPosition(96.75));
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const share = page.getByRole('dialog', { name: 'Share video' });
  const link = share.getByRole('textbox', { name: 'Video link' });
  const plainLink = await link.inputValue();
  await share.getByRole('button', { name: 'Copy link' }).click();
  await share.getByRole('button', { name: 'Copied' }).waitFor();
  check('Share copies the standard link by default', plainLink === 'https://youtu.be/fixture-1'
    && await page.evaluate(() => navigator.clipboard.readText()) === plainLink);
  await share.getByRole('checkbox', { name: 'Start at 1:36' }).check();
  await share.screenshot({ path: path.join(output, 'viewsical-share-video.png') });
  await share.getByRole('button', { name: 'Copy link' }).click();
  await share.getByRole('button', { name: 'Copied' }).waitFor();
  check('Share can copy a link starting at the current playback time', await page.evaluate(() => navigator.clipboard.readText()) === `${plainLink}?t=96`);
  await page.keyboard.press('Escape');
  await share.waitFor({ state: 'hidden' });
}

async function testLocalPlaylists(page, check) {
  const nav = page.getByRole('button', { name: 'Local playlists', exact: true }).first();
  await nav.click();
  await page.getByRole('heading', { name: 'No local playlists yet' }).waitFor();
  const input = page.getByRole('textbox', { name: 'YouTube playlist link' });
  const importButton = page.getByRole('button', { name: 'Import playlist' });
  await input.fill('https://example.test/playlist?list=PLfixture');
  await importButton.click();
  await page.getByRole('alert').getByText('Paste a YouTube playlist link.').waitFor();
  await input.fill('https://www.youtube.com/playlist?list=PLfixture');
  await importButton.click();
  const saved = page.getByRole('button', { name: 'Open Evening listening', exact: true });
  await saved.waitFor();
  check('Signed-out viewers can import a playlist by link', await saved.getByText('3 videos').isVisible());
  await page.screenshot({ path: path.join(output, 'viewsical-local-playlists.png'), clip: { x: 0, y: 0, width: 1000, height: 585 } });
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await nav.click();
  await saved.click();
  await page.getByRole('button', { name: 'Play Fixture video 03 from this playlist' }).click();
  await page.locator('.queue-list').getByText('Fixture video 03', { exact: true }).waitFor();
  check('A stored playlist opens without another remote lookup and starts at the chosen row',
    await page.evaluate(() => {
      const calls = window.__fixture.calls;
      return calls.filter(call => call.command === 'local_playlist').length === 1
        && !calls.some(call => call.command === 'browse' && call.args.kind === 'playlist')
        && calls.filter(call => call.command === 'play_video').at(-1).args.item.playlistIndex === 3;
    }));
  await nav.click();
  await page.getByRole('button', { name: 'Remove Evening listening' }).click();
  await page.getByRole('dialog', { name: 'Remove local playlist?' }).getByRole('button', { name: 'Remove playlist', exact: true }).click();
  await page.getByRole('heading', { name: 'No local playlists yet' }).waitFor();
  check('Removing a playlist updates the local library', !(await saved.isVisible()));
}

async function testWatchActions(page, check) {
  await page.goto('http://127.0.0.1:1423/?watch-actions');
  await page.getByRole('button', { name: 'Play Nightfall piano session', exact: true }).click();
  const row = page.locator('.watch-info-row');
  const subscribe = row.getByRole('button', { name: 'Subscribe', exact: true });
  const save = row.getByRole('button', { name: 'Add to playlist', exact: true });
  const download = row.getByRole('button', { name: 'Download', exact: true });
  const suggestions = page.getByRole('region', { name: 'More to watch', exact: true });
  const more = suggestions.getByRole('button', { name: 'Load more', exact: true });
  await row.getByText('24.8K subscribers').waitFor();
  await subscribe.waitFor();
  await page.waitForFunction(() => !document.querySelector('.watch-channel .channel-subscribe')?.disabled);
  await more.waitFor();
  check('The watch action row shows channel details and an icon-only download',
    await row.locator('.channel-avatar img').evaluate(img => img.complete && img.naturalWidth > 0)
    && !(await download.textContent()).trim() && await row.getByRole('button', { name: 'Queue', exact: true }).count() === 0);
  await row.locator('.watch-channel').screenshot({ path: path.join(output, 'viewsical-subscription-status.png') });
  await subscribe.click();
  await row.getByRole('button', { name: 'Subscribed', exact: true }).waitFor();
  check('The watch Subscribe button acts on the video uploader', await page.evaluate(() =>
    window.__fixture.calls.some(call => call.command === 'set_channel_subscription'
      && call.args.channelId === 'UC1234567890123456789012'
      && call.args.videoId === window.__fixture.calls.find(action => action.command === 'play_video')?.args.item.id
      && call.args.subscribed)));
  await download.click();
  await page.getByRole('dialog', { name: 'Download', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Download', exact: true }).waitFor({ state: 'hidden' });
  await row.getByRole('button', { name: 'Subscribed', exact: true }).click();
  await page.getByRole('dialog', { name: 'Unsubscribe?' }).getByRole('button', { name: 'Unsubscribe', exact: true }).click();
  await row.getByRole('button', { name: 'Subscribe', exact: true }).waitFor();
  await row.locator('.channel-avatar').click();
  const profile = page.getByRole('heading', { name: 'Nightfall Sessions', exact: true });
  await profile.waitFor();
  const goBack = page.locator('.topbar').getByRole('button', { name: 'Go back' });
  await goBack.click();
  await suggestions.getByRole('button', { name: 'Open Blue Hour Music channel', exact: true }).first().press('Enter');
  await profile.waitFor();
  check('Watch avatars and recommendation channel names open profiles without starting another video', await page.evaluate(() => {
    const calls = window.__fixture.calls;
    return calls.filter(call => call.command === 'play_video').length === 1
      && calls.some(call => call.command === 'video_channel' && call.args.videoId === 'fixture-2');
  }));
  await goBack.click();
  const visibleCount = () => suggestions.locator('.recommendation').count();
  const pageCalls = () => page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'browse' && call.args.kind === 'home'));
  check('Recommendations start with eight items', await visibleCount() === 8 && (await pageCalls()).length === 1);
  await row.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const viewport = page.viewportSize();
  const info = await page.locator('.video-details').boundingBox();
  const top = Math.max(64, Math.floor(info.y - 22));
  await page.screenshot({ path: path.join(output, 'viewsical-watch-actions.png'),
    clip: { x: Math.max(0, Math.floor(info.x - 14)), y: top,
      width: viewport.width - Math.floor(info.x - 14), height: Math.min(305, viewport.height - top) } });
  await more.scrollIntoViewIfNeeded();
  const moreBox = await more.boundingBox();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(output, 'viewsical-watch-load-more.png'),
    clip: { x: Math.floor(moreBox.x - 10), y: Math.max(64, Math.floor(moreBox.y - 265)),
      width: Math.ceil(moreBox.width + 20), height: 315 } });
  await more.click();
  check('Load more reveals cached suggestions without a fetch', await visibleCount() === 16 && (await pageCalls()).length === 1);
  await more.click();
  await page.evaluate(() => { window.__fixture.failWatchPage = true; });
  await more.click();
  await suggestions.getByText('Fixture suggestions unavailable').waitFor();
  await suggestions.getByRole('button', { name: 'Retry', exact: true }).click();
  await suggestions.getByRole('button', { name: 'Play Fixture video 25', exact: true }).waitFor();
  check('Load more retries a failed continuation and appends fresh suggestions', await visibleCount() === 31
    && (await pageCalls()).map(call => call.args.cursor).join(',') === ',24,24');

  await save.click();
  const dialog = page.getByRole('dialog', { name: 'Add to playlist', exact: true });
  await dialog.getByRole('button', { name: 'New local playlist' }).click();
  await dialog.getByRole('textbox', { name: 'Playlist name' }).fill('Evening instrumentals');
  await dialog.getByRole('button', { name: 'Create and save' }).click();
  await page.getByText('Saved to Evening instrumentals', { exact: true }).waitFor();
  await save.click();
  const local = dialog.getByRole('button', { name: 'Evening instrumentals', exact: true });
  await local.waitFor();
  await dialog.screenshot({ path: path.join(output, 'viewsical-watch-save-playlist.png') });
  await local.click();
  await dialog.waitFor({ state: 'hidden' });
  await save.click();
  await dialog.getByRole('button', { name: 'YouTube playlists' }).click();
  await dialog.getByRole('button', { name: 'Watch later' }).click();
  await page.getByText('Saved to Watch later', { exact: true }).waitFor();
  check('The picker saves to new and existing local playlists and to YouTube',
    await page.evaluate(() => {
      const local = window.__fixture.calls.filter(call => call.command === 'save_local_playlist_video');
      return local.length === 2 && local[0].args.title === 'Evening instrumentals'
        && local[1].args.playlistId === 'local:evening'
        && window.__fixture.calls.some(call => call.command === 'youtube_playlist_save' && call.args.playlistId === 'WL');
    }));
  await page.goto('http://127.0.0.1:1423/?watch-actions&anonymous');
  await page.getByRole('button', { name: 'Play Nightfall piano session', exact: true }).click();
  await save.click();
  check('Signed-out viewers can save locally and see disabled YouTube actions',
    await subscribe.isDisabled() && await dialog.getByRole('button', { name: 'YouTube playlists' }).isDisabled()
    && await dialog.getByRole('button', { name: 'New local playlist' }).isEnabled());
}

async function testWatchActionOverflow(page, check) {
  await page.goto('http://127.0.0.1:1423/?watch-actions&long-creator');
  await page.getByRole('button', { name: 'Play Nightfall piano session', exact: true }).click();
  const row = page.locator('.watch-info-row');
  const more = row.getByRole('button', { name: 'More video actions', exact: true });
  const directSave = row.getByRole('button', { name: 'Add to playlist', exact: true });
  const directDownload = row.getByRole('button', { name: 'Download', exact: true });
  const menu = row.getByRole('menu', { name: 'More video actions', exact: true });
  const save = menu.getByRole('menuitem', { name: 'Add to playlist', exact: true });
  const download = menu.getByRole('menuitem', { name: 'Download', exact: true });
  const title = page.getByRole('heading', { name: 'Nightfall piano session', exact: true });
  await more.waitFor();
  const channel = row.getByRole('button', { name: /Open Nightfall Sessions & the Midnight Orchestra/ });
  const channelBox = await channel.boundingBox();
  const moreBox = await more.boundingBox();
  check('A long creator name moves only playlist and download into the overflow menu',
    !await directSave.isVisible() && !await directDownload.isVisible()
    && await row.getByRole('button', { name: 'Share', exact: true }).isVisible()
    && await row.getByRole('button', { name: 'Like', exact: true }).isVisible()
    && Math.abs(moreBox.y - channelBox.y) <= 10);

  await more.focus();
  await more.press('ArrowDown');
  await save.waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Add to playlist');
  await save.press('ArrowDown');
  check('The overflow menu supports arrow navigation', await download.evaluate(item => item === document.activeElement));
  await download.press('Escape');
  check('Escape dismisses the overflow menu and restores focus', !await menu.isVisible()
    && await more.evaluate(button => button === document.activeElement));

  await more.click();
  await page.locator('.video-details').screenshot({ path: path.join(output, 'viewsical-watch-action-overflow.png') });
  await title.click();
  check('Clicking outside the overflow menu closes it', !await menu.isVisible());
  await more.click();
  await save.click();
  const playlistDialog = page.getByRole('dialog', { name: 'Add to playlist', exact: true });
  await playlistDialog.waitFor();
  await page.keyboard.press('Escape');
  await playlistDialog.waitFor({ state: 'hidden' });
  await more.click();
  await download.click();
  const downloadDialog = page.getByRole('dialog', { name: 'Download', exact: true });
  await downloadDialog.waitFor();
  await page.keyboard.press('Escape');
  await downloadDialog.waitFor({ state: 'hidden' });
  check('Both overflow items open their existing dialogs', !await menu.isVisible());

  const viewport = page.viewportSize();
  await page.setViewportSize({ ...viewport, width: 2000 });
  await directSave.waitFor();
  check('Widening the window brings back both inline buttons', await directDownload.isVisible() && !await more.isVisible());
  await page.locator('.video-details').screenshot({ path: path.join(output, 'viewsical-watch-action-inline.png') });
  await page.setViewportSize(viewport);
  await more.waitFor();
  check('Narrowing the same window returns the optional actions to the menu', !await directSave.isVisible());
}

async function testHomeCreatorAndMix(page, check) {
  await page.goto('http://127.0.0.1:1423/?watch-actions&home-mix');
  const mix = page.locator('.video-card').filter({ has: page.getByRole('button', { name: 'Play Mix - Nightfall Sessions', exact: true }) });
  const kit = page.locator('.video-card').filter({ has: page.getByRole('button', { name: 'Play Nightfall piano session', exact: true }) });
  const creator = kit.getByRole('button', { name: 'Nightfall Sessions', exact: true });
  const started = () => page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'play_video'));
  await creator.waitFor();
  await creator.hover();
  const cards = await mix.boundingBox();
  const videoCard = await kit.boundingBox();
  await page.screenshot({ path: path.join(output, 'viewsical-home-creator-mix.png'), clip: {
    x: Math.floor(cards.x - 12), y: Math.floor(cards.y - 66), width: Math.ceil(videoCard.x + videoCard.width - cards.x + 24),
    height: Math.ceil(cards.height + 85),
  } });
  await creator.click();
  await page.getByRole('region', { name: 'Nightfall Sessions', exact: true }).waitFor();
  check('The creator name opens its profile from Home without starting playback', (await started()).length === 0);
  const back = page.locator('.topbar').getByRole('button', { name: 'Go back', exact: true });
  await back.click();
  await mix.getByRole('button', { name: 'View full playlist', exact: true }).click();
  await page.getByRole('heading', { name: 'Mix - Nightfall Sessions', exact: true }).waitFor();
  check('View full playlist opens the mix without starting playback', (await started()).length === 0);
  await back.click();
  await mix.getByRole('button', { name: 'Play Mix - Nightfall Sessions', exact: true }).click();
  await page.locator('.video-details h1').getByText('Fixture video 01', { exact: true }).waitFor();
  check('The Home mix starts with the playlist’s first video and keeps the queue',
    (await started()).length === 1 && (await started())[0].args.item.id === 'fixture-1'
    && await page.locator('.queue-item').count() >= 2);
  await page.locator('.sidebar').getByRole('button', { name: 'Playlists', exact: true }).click();
  const playlist = page.locator('.video-card').filter({ has: page.getByRole('button', { name: 'Play Evening listening', exact: true }) });
  await playlist.getByRole('button', { name: 'View full playlist', exact: true }).hover();
  const playlistCard = await playlist.boundingBox();
  await page.screenshot({ path: path.join(output, 'viewsical-playlists-card-actions.png'), clip: {
    x: Math.floor(playlistCard.x - 12), y: Math.floor(playlistCard.y - 66),
    width: Math.ceil(playlistCard.width + 24), height: Math.ceil(playlistCard.height + 85),
  } });
  await playlist.getByRole('button', { name: 'Play Evening listening', exact: true }).click();
  await page.waitForFunction(() => window.__fixture.calls.filter(call => call.command === 'play_video').length === 2);
  check('The Playlists tab also starts playback at the first video', (await started())[1].args.item.id === 'fixture-1');
  await back.click();
  const liked = page.locator('.video-card').filter({ has: page.getByRole('button', { name: 'Play Liked videos', exact: true }) });
  const fullLiked = liked.getByRole('button', { name: 'View full playlist', exact: true });
  await fullLiked.waitFor();
  check('Liked videos shows one View full playlist label even when YouTube supplies it as the owner',
    await liked.getByText('View full playlist', { exact: true }).count() === 1);
  await liked.screenshot({ path: path.join(output, 'viewsical-liked-playlist-single-button.png') });
  await fullLiked.click();
  await page.getByRole('heading', { name: 'Liked videos', exact: true }).waitFor();
  check('The remaining Liked videos button opens the full list', (await started()).length === 2);
}

async function testChannelSubscription(page, check) {
  await page.goto('http://127.0.0.1:1423/');
  const sidebar = page.locator('.sidebar');
  const subscriptions = sidebar.getByRole('button', { name: 'Subscriptions', exact: true });
  await subscriptions.click();
  await page.getByRole('button', { name: 'Play Other creator update', exact: true }).waitFor();
  await sidebar.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Play Fixture video 01', exact: true }).click();
  await page.getByRole('button', { name: 'Viewer 2', exact: true }).click();
  const profile = page.getByRole('region', { name: 'Nightfall Sessions', exact: true });
  const subscribe = profile.getByRole('button', { name: 'Subscribe', exact: true });
  const subscribed = profile.getByRole('button', { name: 'Subscribed', exact: true });
  const writes = () => page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'set_channel_subscription'));
  const reads = () => page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'channel_subscription'));
  await subscribe.click();
  await subscribed.waitFor();
  const initialReads = await reads();
  check('The subscription check is scoped to the active channel and account',
    initialReads.length === 1 && initialReads[0].args.channelId === 'UC1234567890123456789012'
    && initialReads[0].args.generation === 1 && initialReads[0].args.videoId == null);
  const mutations = await writes();
  check('A connected viewer can subscribe to the channel', mutations.length === 1
    && mutations[0].args.channelId === 'UC1234567890123456789012'
    && mutations[0].args.generation === 1
    && mutations[0].args.subscribed === true);

  await profile.getByRole('tab', { name: 'Videos', exact: true }).click();
  await page.getByRole('button', { name: 'Play Moonrise over the keys', exact: true }).waitFor();
  check('Switching channel tabs keeps the state without another subscription lookup',
    await subscribed.isVisible() && (await reads()).length === 1);
  const closePlayer = page.getByRole('button', { name: 'Close player', exact: true });
  await closePlayer.click();
  await closePlayer.waitFor({ state: 'hidden' });
  await page.mouse.move(0, 0);
  await profile.getByRole('tab', { name: 'Videos', exact: true }).blur();
  await page.screenshot({ path: path.join(output, 'viewsical-channel-profile.png') });

  await subscriptions.click();
  await page.getByRole('button', { name: 'Play Nightfall piano session', exact: true }).waitFor();
  check('Subscribing refreshes a previously cached Subscriptions feed when reopened',
    await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'browse' && call.args.kind === 'subscriptions').length === 2));
  await page.locator('.topbar').getByRole('button', { name: 'Go back', exact: true }).click();
  await subscribed.waitFor();
  const confirmation = page.getByRole('dialog', { name: 'Unsubscribe?' });
  await subscribed.click();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  check('Cancel leaves the subscription in place', (await writes()).length === 1 && await subscribed.isVisible());
  await subscribed.click();
  await confirmation.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
  await subscribe.waitFor();
  const finalMutations = await writes();
  check('Unsubscribing requires confirmation and returns to Subscribe', finalMutations.length === 2
    && finalMutations[1].args.channelId === mutations[0].args.channelId
    && finalMutations[1].args.subscribed === false);
}

async function testSubscriptionRecovery(page, check) {
  await page.goto('http://127.0.0.1:1423/?watch-actions');
  await page.evaluate(() => { window.__fixture.nextSubscriptionReadError = 'subscription_status_unavailable'; });
  await page.getByRole('button', { name: 'Play Nightfall piano session', exact: true }).click();
  const watch = page.locator('.watch-channel');
  const retry = watch.getByRole('button', { name: 'Retry', exact: true });
  const subscribe = watch.getByRole('button', { name: 'Subscribe', exact: true });
  const subscribed = watch.getByRole('button', { name: 'Subscribed', exact: true });
  const writes = () => page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'set_channel_subscription').length);
  await retry.waitFor();
  check('An unreadable status offers Retry without permitting a subscription change',
    await subscribe.isDisabled() && await writes() === 0);
  await retry.click();
  await page.evaluate(() => { window.__fixture.nextSubscriptionWriteError = 'subscription_write_rejected'; });
  await subscribe.click();
  await watch.getByText("YouTube didn't accept this subscription change.").waitFor();
  check('A rejected change keeps the previously confirmed state', await subscribe.isEnabled() && await writes() === 1);

  await page.evaluate(() => { window.__fixture.nextSubscriptionWriteError = 'subscription_confirmation_pending'; });
  await subscribe.click();
  const checkStatus = watch.getByRole('button', { name: 'Check status', exact: true });
  await checkStatus.waitFor();
  check('An uncertain change blocks another write until status is checked', await subscribe.isDisabled());
  await page.locator('.watch-info-row').screenshot({ path: path.join(output, 'viewsical-subscription-recovery.png') });
  await checkStatus.click();
  await subscribed.waitFor();
  check('Checking status reflects the change without resubmitting it', await writes() === 2);
  await page.locator('.watch-info-row').screenshot({ path: path.join(output, 'viewsical-subscription-confirmed.png') });

  await page.evaluate(() => { window.__fixture.nextSubscriptionReadError = 'sign_in_required'; });
  await watch.getByRole('button', { name: 'Open Nightfall Sessions channel' }).click();
  const profile = page.getByRole('region', { name: 'Nightfall Sessions', exact: true });
  const signIn = profile.getByRole('button', { name: 'Sign in', exact: true });
  await signIn.click();
  await page.getByRole('dialog', { name: 'Sign in to YouTube', exact: true }).waitFor();
  check('An expired subscription session opens the existing sign-in flow',
    await page.evaluate(() => window.__fixture.calls.some(call => call.command === 'open_sign_in')) && await writes() === 2);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__fixture.switchSubscriptionAccount(false));
  const reopenProfile = async () => {
    await page.getByRole('button', { name: 'Play Nightfall piano session', exact: true }).click();
    await watch.getByRole('button', { name: 'Open Nightfall Sessions channel' }).click();
  };
  await reopenProfile();
  const profileSubscribe = profile.getByRole('button', { name: 'Subscribe', exact: true });
  await page.evaluate(() => { window.__fixture.deferSubscriptionWrite = true; });
  await profileSubscribe.click();
  await page.waitForFunction(() => Boolean(window.__fixture.finishSubscriptionWrite));
  await page.evaluate(() => window.__fixture.switchSubscriptionAccount(false));
  await reopenProfile();
  await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'channel_subscription' && call.args.generation === 3 && call.args.videoId == null));
  await page.waitForFunction(() => !document.querySelector('.channel-profile .channel-subscribe')?.disabled);
  await page.evaluate(async () => {
    window.__fixture.finishSubscriptionWrite();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  check('A late change from another account leaves the current account state alone',
    await profileSubscribe.isEnabled() && await profile.getByRole('button', { name: 'Subscribed', exact: true }).count() === 0);
}

async function testSeekThumb(page, check) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('http://127.0.0.1:1423/?player-overlay=1&paused=1');
  await page.mouse.move(500, 250);
  const slider = page.getByRole('slider', { name: 'Playback position' });
  const { x, y } = await thumbPosition(slider);
  // Sample inside the opaque face so changes to the rail don't affect the comparison.
  const face = () => page.screenshot({ clip: { x: Math.round(x) - 6, y: Math.round(y) + 2, width: 12, height: 5 } });
  const idle = await face();
  await scrubAt(page, slider, 0.75);
  const railHover = await face();
  await page.mouse.move(x, y);
  await page.waitForTimeout(160);
  const iconHover = await face();
  check('Only hovering the cat thumb changes its expression', idle.equals(railHover) && !idle.equals(iconHover));
  await timelineScreenshot(page, slider, 'player-cat-wink.png', 180);

  await page.mouse.down();
  await page.mouse.move(x, y - 23);
  await page.waitForTimeout(160);
  check('The cat keeps winking at 1.05 scale during a captured drag',
    (await slider.getAttribute('data-seeking')) !== null
    && await slider.evaluate(el => getComputedStyle(el).getPropertyValue('--seek-thumb-scale').trim() === '1.05')
    && iconHover.equals(await face()));
  await page.mouse.up();
  await page.waitForTimeout(160);
  check('The thumb returns to its idle expression after the drag',
    (await slider.getAttribute('data-seeking')) === null && idle.equals(await face()));
  await page.evaluate(() => document.activeElement?.blur());
  await timelineScreenshot(page, slider, 'player-cat-idle.png', 45);
  const settings = page.getByRole('button', { name: 'Playback settings', exact: true });
  await settings.click();
  await page.getByRole('menuitem', { name: /Quality/ }).click();
  await page.getByRole('menuitemradio', { name: '720p' }).click();
  await settings.getByText('720p', { exact: true }).waitFor();
  check('Changing the video resolution updates the number beside the gear',
    await settings.getAttribute('aria-description') === 'Current video quality 720p');
}

async function testSubtitleOptions(page, check) {
  const settings = page.getByRole('button', { name: 'Playback settings', exact: true });
  await settings.click();
  check('Video startup and opening settings leave subtitle lookups idle', await page.evaluate(() => !window.subtitleLookups));
  await page.getByRole('menuitem', { name: 'Subtitles Off' }).click();
  const captions = page.getByRole('menuitemradio', { name: 'English', exact: true });
  const automatic = page.getByRole('menuitemradio', { name: 'Spanish Auto-generated', exact: true });
  const off = page.getByRole('menuitemradio', { name: 'Off', exact: true });
  await captions.waitFor({ state: 'visible' });
  check('Subtitle options show Off, uploaded tracks, and labeled automatic tracks',
    (await off.getAttribute('aria-checked')) === 'true' && await automatic.isVisible());
  await captions.click();
  await page.waitForFunction(() => document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent === 'English');
  check('Selecting a subtitle sends the active video load and track ID', await page.evaluate(() =>
    window.subtitleActions?.some(action => action.loadId === 1 && action.trackId === 'english')));
  const menu = await page.getByRole('menu', { name: 'Playback settings' }).boundingBox();
  await page.screenshot({ path: path.join(output, 'viewsical-subtitles-menu.png'), clip: {
    x: Math.floor(menu.x - 15), y: Math.floor(menu.y - 15), width: Math.ceil(1000 - menu.x + 15),
    height: Math.floor(560 - menu.y + 15),
  } });
  await off.click();
  await page.waitForFunction(() => document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent === 'Off');
  check('Turning subtitles off is scoped to the active video', await page.evaluate(() =>
    window.subtitleActions?.some(action => action.loadId === 1 && action.trackId === null)));
  await page.goto('http://127.0.0.1:1423/?player-overlay=1&noSubtitles=1');
  await page.mouse.move(500, 250);
  await settings.click();
  await page.getByRole('menuitem', { name: 'Subtitles Off' }).click();
  await page.getByText('No subtitles available for this video.').waitFor({ state: 'visible' });
  check('A video without captions shows an empty state in the subtitle menu', await page.getByRole('menuitemradio').count() === 0);
}

async function scaledOverlayChecks(browser, output, check) {
  for (const scale of [1,1.25,1.5,2]) for (const theme of ['dark','light']) {
    const context=await browser.newContext({viewport:{width:1000,height:560},deviceScaleFactor:scale,colorScheme:theme,reducedMotion:'reduce'}), page=await context.newPage();
    const images = [];
    await page.route(sheetRoute, route => { images.push(route.request().url()); return previewSheet(route); });
    await page.addInitScript(()=>{
      let callbackId=0;const callbacks=new Map(),listeners=new Map();
      const search = new URLSearchParams(location.search);
      const paused = search.has('paused');
      const player={status:paused ? 'paused' : 'playing',video:{id:'dQw4w9WgXcQ',kind:'video',title:'Scaled shared controls',channel:'Fixture',thumbnail:null,url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',duration:360,viewCount:1,description:null},position:paused ? 170 : 30,duration:360,volume:37,muted:false,speed:1,quality:1080,qualities:[1080,720,480],error:null,loadId:1,playbackMode:'video',requestedQuality:1080,bufferedSeconds:30,errorCode:null};
      player.video.heatmap=[{startTime:0,endTime:120,value:0.15},{startTime:120,endTime:240,value:1},{startTime:240,endTime:360,value:0.3}];
      player.video.chapters=[{startTime:0,endTime:90,title:'Intro'},{startTime:90,endTime:240,title:'Main section'},{startTime:240,endTime:360,title:'Outro'}];
      player.storyboard={urlTemplate:'https://i.ytimg.com/sb/timeline-fixture/M$M.jpg',width:160,height:90,columns:2,rows:2,frameCount:12,frameDuration:30};
      let revision = 1;
      const snapshot = () => ({revision,player,ui:{hasPrevious:true,hasNext:true,mini:false,theater:false,fullscreen:false},pausedIntent:true,overlayError:null});
      const publish = () => {
        revision++;
        for (const [id, listener] of listeners) {
          if (listener.event === 'player-presentation') callbacks.get(listener.handler)?.({ id, event: listener.event, payload: snapshot() });
        }
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_,id)=>listeners.delete(id)};
      window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'player-overlay'},currentWebview:{label:'player-overlay'}},transformCallback:fn=>{const id=++callbackId;callbacks.set(id,fn);return id;},unregisterCallback:id=>callbacks.delete(id),invoke:async(command,args={})=>{
        if(command==='plugin:event|listen'){const id=++callbackId;listeners.set(id,args);return id;}
        if(command==='plugin:event|unlisten'){listeners.delete(args.eventId);return;}
        if(command==='player_overlay_snapshot')return snapshot();
        if(command==='player_subtitle_tracks'){
          window.subtitleLookups = (window.subtitleLookups ?? 0) + 1;
          return search.has('noSubtitles') ? [] : [
            { id: 'english', label: 'English', language: 'en', automatic: false },
            { id: 'spanish-auto', label: 'Spanish', language: 'es', automatic: true },
          ];
        }
        if (command === 'set_player_subtitle') {
          (window.subtitleActions ??= []).push(args);
          player.subtitleTrackId = args.trackId;
          publish();
          return;
        }
        if(command==='player_overlay_action'){
          (window.overlayActions ??= []).push(args);
          if (args.action === 'quality') {
            player.quality = args.value;
            publish();
          }
          return;
        }
        throw Error('Unexpected scaled overlay fixture command '+command);
      }};
    });
    await page.goto('http://127.0.0.1:1423/?player-overlay=1');await page.locator('.player-overlay-root').waitFor();await page.mouse.move(500,250);await page.getByRole('button',{name:'Playback settings',exact:true}).click();
    const settingsButton = page.getByRole('button', { name: 'Playback settings', exact: true });
    check(`The Settings gear shows the current resolution at DPR ${scale} in ${theme}`,
      await settingsButton.locator('.player-current-quality').textContent() === '1080p'
      && await settingsButton.getAttribute('aria-description') === 'Current video quality 1080p');
    const graph = page.locator('.seek-heatmap');
    check(`Video replay heatmap fits at DPR ${scale} in ${theme} scheme`, await graph.isVisible() && await graph.evaluate(el => {
      const graph = el.getBoundingClientRect(), slider = el.parentElement.querySelector('input');
      const rail = slider.getBoundingClientRect(), style = getComputedStyle(el);
      const description = document.getElementById(slider.getAttribute('aria-describedby'));
      return graph.left >= rail.left && graph.right <= rail.right && Math.abs(graph.bottom - rail.top) < 0.5
        && style.pointerEvents === 'none' && style.clipPath.startsWith('polygon(')
        && description?.textContent === 'Most replayed around 3:00';
    }));
    const dimensions=await page.locator('.player-settings-menu').evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return{ratio:devicePixelRatio,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,shadow:s.boxShadow,radius:s.borderRadius,stroke:[...el.querySelectorAll(':scope > button > svg')].map(svg=>getComputedStyle(svg).strokeWidth),rowHeights:[...el.querySelectorAll(':scope > button')].map(b=>b.getBoundingClientRect().height),overflow:document.documentElement.scrollWidth>innerWidth};});
    check(`Shared menu fits at DPR ${scale} in ${theme} scheme`,Math.abs(dimensions.ratio-scale)<.001&&Math.abs(dimensions.width-305)<1&&dimensions.x>=0&&dimensions.y>=0&&dimensions.right<=1000&&dimensions.bottom<=560&&!dimensions.overflow&&dimensions.shadow==='none'&&dimensions.radius==='12px'&&dimensions.stroke.every(x=>x==='2px')&&dimensions.rowHeights.every(h=>h>=44),dimensions);
    await page.screenshot({path:path.join(output,`v017-browser-menu-${theme}-${String(scale).replace('.','_')}.png`)});
    await page.getByRole('menuitem',{name:/Playback speed/}).click();const menu=page.locator('.player-settings-menu');const before=await menu.evaluate(el=>el.scrollTop);await menu.hover();await page.mouse.wheel(0,250);await page.waitForTimeout(80);check(`Speed submenu remains independently scrollable at DPR ${scale} in ${theme}`,await menu.evaluate(el=>getComputedStyle(el).scrollbarWidth!=='none'&&el.scrollHeight>el.clientHeight&&el.scrollTop>0)&&before===0);
    if (scale === 1 || scale === 2) {
      await page.keyboard.press('Escape');
      check(`Storyboard sheets load on demand at DPR ${scale} in ${theme}`, images.length === 0);
      const slider = page.getByRole('slider', { name: 'Playback position' });
      const preview = page.locator('.seek-preview');
      const segments = page.locator('.seek-chapter-segment');
      const idle = await chapterGeometry(segments);
      const sampleFractions = [0.14, 0.42, 0.61, 0.84];
      const idlePixels = await railPixels(page, slider, sampleFractions);
      check(`Three chapter segments have short gaps and an accessible chapter name at DPR ${scale} in ${theme}`,
        idle.length === 3 && idle.every(segment => segment.gradient.startsWith('linear-gradient(')) && idle.slice(1).every((segment, i) => {
          const gap = segment.left - idle[i].right;
          return gap > 0 && gap <= 3;
        }) && (await slider.getAttribute('aria-valuetext')).endsWith(', Intro'), idle);
      await scrubAt(page, slider, 75 / 360);
      await preview.locator('.seek-preview-image').waitFor();
      const active = await chapterGeometry(segments);
      check(`Hover shows the matching tile and chapter at DPR ${scale} in ${theme}`,
        (await preview.locator('img').getAttribute('src')).endsWith('/M0.jpg')
        && await preview.locator('img').evaluate(el => el.naturalWidth === 320 && el.style.left === '0%' && el.style.top === '-100%')
        && await preview.locator('.seek-preview-chapter').textContent() === 'Intro');
      check(`Hover thickens only the active chapter on the rail at DPR ${scale} in ${theme}`,
        await segments.nth(0).evaluate(el => el.classList.contains('is-active'))
        && await page.locator('.seek-chapter-segment.is-active').count() === 1
        && active[0].height > idle[0].height + 1
        && Math.abs(active[0].center - idle[0].center) < 1
        && active.slice(1).every((segment, i) => Math.abs(segment.height - idle[i+1].height) < 0.5), { idle, active });
      check(`The timestamp and title float underneath the thumbnail at DPR ${scale} in ${theme}`, await preview.evaluate(el => {
        const image = el.querySelector('.seek-preview-image');
        const caption = el.querySelector('.seek-preview-caption');
        return image.nextElementSibling === caption
          && caption.contains(el.querySelector('.seek-preview-time'))
          && caption.contains(el.querySelector('.seek-preview-chapter'))
          && caption.getBoundingClientRect().top >= image.getBoundingClientRect().bottom
          && parseFloat(getComputedStyle(image).borderTopLeftRadius) > 0
          && [el, caption].every(container => getComputedStyle(container).backgroundColor === 'rgba(0, 0, 0, 0)');
      }));
      await scrubAt(page, slider, 195 / 360);
      await preview.locator('.seek-preview-image').waitFor();
      check(`Moving across sheets updates the chapter and replay label at DPR ${scale} in ${theme}`,
        (await preview.locator('img').getAttribute('src')).endsWith('/M1.jpg')
        && await preview.locator('.seek-preview-chapter').textContent() === 'Main section'
        && await preview.locator('.seek-preview-peak').textContent() === 'Most replayed'
        && await segments.nth(1).evaluate(el => el.classList.contains('is-active'))
        && await page.evaluate(() => !window.overlayActions?.some(action => action.action === 'seek')));
      const hoverPixels = await railPixels(page, slider, sampleFractions);
      check(`Hover brightens the rail up to the pointer across chapter gaps with no vertical line at DPR ${scale} in ${theme}`,
        await page.locator('.seek-preview-guide').count() === 0
        && hoverPixels.every((color, i) => i < 2
          ? color[1] > idlePixels[i][1] + 12 && color[2] > idlePixels[i][2] + 12
          : color.every((channel, k) => channel === idlePixels[i][k])), { idlePixels, hoverPixels });
      if (scale === 1 && theme === 'dark') {
        check('The regular video preview keeps its original caption styling',
          await preview.locator('.seek-preview-caption').evaluate(el => getComputedStyle(el).backdropFilter === 'none'));
        await page.waitForTimeout(2700);
        check('The preview stays visible while the pointer rests on the playing timeline', await preview.locator('.seek-preview-image').isVisible());
        await page.evaluate(() => document.activeElement?.blur());
        await timelineScreenshot(page, slider, 'timeline-hover-video.png', 190);
      }
      await page.mouse.down();
      const missingSheet = page.waitForResponse(response => response.url().endsWith('/M2.jpg') && response.status() === 404);
      await scrubAt(page, slider, 0.99);
      await missingSheet;
      const right = await preview.boundingBox();
      check(`A missing image keeps the time and chapter in bounds while dragging at DPR ${scale} in ${theme}`,
        await preview.locator('.seek-preview-image').isHidden()
        && await preview.locator('.seek-preview-chapter').textContent() === 'Outro' && right.x + right.width <= 1000);
      await page.mouse.up();
      await page.waitForFunction(() => window.overlayActions?.filter(action => action.action === 'seek').length === 1);
      await page.mouse.move(500,250);
      await preview.waitFor({state:'hidden'});
    }
    if (scale === 2 && theme === 'dark') {
      await testSeekThumb(page, check);
      await testSubtitleOptions(page, check);
      await page.mouse.move(500, 250);
      await page.getByRole('button', { name: 'Minimize player', exact: true }).click();
      check('The fallback video controls send a minimize request for the active playback',
        await page.evaluate(() => window.overlayActions.at(-1)?.action === 'minimize' && window.overlayActions.at(-1)?.loadId === 1));
    }
    await context.close();
  }
}
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const images = [];
  await page.route(sheetRoute, route => { images.push(route.request().url()); return previewSheet(route); });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const art = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#6c7da2"/><stop offset=".6" stop-color="#243957"/><stop offset="1" stop-color="#131b32"/></linearGradient></defs><path fill="url(#g)" d="M0 0h640v360H0z"/><circle fill="#d8c4ad" cx="490" cy="95" r="47"/><path fill="#405777" d="m0 270 130-145 130 115L420 80l220 210v70H0z"/><path fill="#16263f" d="m0 320 170-135 120 115 115-105 235 140v25H0z"/></svg>')}`;
    const video = index => ({ id: index === 3 || index === 28 ? 'duplicate-id' : `fixture-${index}`, kind: 'video', title: `Fixture video ${String(index).padStart(2, '0')}`, channel: 'Fixture Music', thumbnail: art, url: `https://www.youtube.com/watch?v=fixture${index}`, duration: 190 + index, viewCount: 10000 + index * 153, description: null, playlistIndex: index,
      ...(index >= 119 && { heatmap: [{ startTime: 0, endTime: 50, value: 0.1 }, { startTime: 50, endTime: 100, value: 0.9 }, { startTime: 100, endTime: 190 + index, value: 0.35 }],
        chapters: [{ startTime: 0, endTime: 80, title: 'Overture' }, { startTime: 80, endTime: 190 + index, title: 'Main theme' }] }),
    });
    const playlist = { id: 'PLfixture', kind: 'playlist', title: 'Evening listening', channel: 'Fixture listener', thumbnail: art, url: 'https://www.youtube.com/playlist?list=PLfixture', duration: null, viewCount: null, description: 'A quiet collection for the end of the day.' };
    const collection = { id: 'PLfixture', title: playlist.title, owner: playlist.channel, thumbnail: art, itemCount: 120, description: playlist.description, isMix: false, url: playlist.url };
    const liked = { ...playlist, id: 'LL', title: 'Liked videos', channel: 'View full playlist', url: 'https://www.youtube.com/playlist?list=LL' };
    const likedCollection = { ...collection, id: liked.id, title: liked.title, owner: '', url: liked.url };
    const mix = { ...playlist, id: 'RDfixture', title: 'Mix - Nightfall Sessions', channel: '', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDfixture' };
    const mixCollection = { ...collection, id: mix.id, title: mix.title, owner: mix.channel, isMix: true, url: mix.url };
    const banner = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="230" viewBox="0 0 1200 230"><defs><linearGradient id="sky" x2="1" y2="1"><stop stop-color="#101223"/><stop offset=".7" stop-color="#293861"/><stop offset="1" stop-color="#74688e"/></linearGradient><radialGradient id="glow"><stop stop-color="#ffe1b8" stop-opacity=".5"/><stop offset="1" stop-color="#ffe1b8" stop-opacity="0"/></radialGradient></defs><path fill="url(#sky)" d="M0 0h1200v230H0z"/><circle cx="935" cy="87" r="125" fill="url(#glow)"/><circle cx="935" cy="87" r="42" fill="#f6d6b1"/><path fill="#3f5073" d="M0 159 130 84l120 56L365 43l177 100 104-50 146 78 153-50 255 63v46H0z"/><path fill="#243250" d="M0 204 180 148l125 40L479 90l120 74 143-44 122 60 144-34 192 56v28H0z"/><path fill="#161e37" d="m0 226 208-32 120 24 122-48 178 38 222-34 157 37 193-25v44H0z"/></svg>')}`;
    const avatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><linearGradient id="sky" x2="1" y2="1"><stop stop-color="#66568c"/><stop offset="1" stop-color="#192338"/></linearGradient></defs><path fill="url(#sky)" d="M0 0h256v256H0z"/><circle cx="157" cy="82" r="50" fill="#f6d6b1"/><circle cx="178" cy="63" r="46" fill="#41436f"/><path fill="#374066" d="m0 196 86-80 83 83 43-28 44 29v56H0z"/><path fill="#212a44" d="m0 223 72-42 45 36 66-54 73 41v52H0z"/></svg>')}`;
    const channelProfile = {
      id: 'UC1234567890123456789012', title: 'Nightfall Sessions', handle: '@nightfallsessions',
      avatar, banner, description: 'Piano sessions after dark. Studio performances, arrangements, and live sets.',
      subscriberCount: 24800, videoCount: 135,
    };
    const channelArtwork = [
      art,
      art.replace('6c7da2', '8a778f').replace('405777', '6f5077').replace('d8c4ad', 'f3c49a'),
      art.replace('6c7da2', '7b999b').replace('405777', '386570').replace('d8c4ad', 'd9e2bd'),
    ];
    const sessionVideo = (index, title) => ({ ...video(index), title, channel: channelProfile.title, thumbnail: channelArtwork[index % channelArtwork.length] });
    const channelItems = {
      'channel-home': [sessionVideo(4, 'Nightfall piano session'), sessionVideo(5, 'The blue hour'), sessionVideo(6, 'Quiet arrangements for late nights')],
      channel: [sessionVideo(7, 'Moonrise over the keys'), sessionVideo(8, 'Midnight piano improvisation'), sessionVideo(9, 'An evening in the studio')],
      'channel-live': [sessionVideo(10, 'Late-night studio livestream')],
      'channel-playlists': [{ ...playlist, channel: channelProfile.title }],
    };
    const localCollection = { ...collection, itemCount: 3 };
    let savedLocalPlaylist = false;
    let createdPlaylist;
    let channelSubscribed = false;
    const MiB = 1024 ** 2;
    const cacheData = { enabled: true, content: 'both', maxBytes: 2 * 1024 ** 3, totalBytes: 120 * MiB, audioBytes: 16 * MiB, videoBytes: 96 * MiB, pendingBytes: 8 * MiB, entryCount: 3, activeCount: 1, entries: [
      { id: 'cached-audio', videoId: 'audio', title: 'Fixture cached audio', mode: 'audio', quality: 0, bytes: 16 * MiB, lastAccessed: 1780000000, pinned: false },
      { id: 'cached-video', videoId: 'video', title: 'Fixture cached video', mode: 'video', quality: 720, bytes: 64 * MiB, lastAccessed: 1780000000, pinned: false },
      { id: 'playing-cache', videoId: 'playing', title: 'Fixture currently playing', mode: 'video', quality: 1080, bytes: 32 * MiB, lastAccessed: 1780000000, pinned: true },
    ] };
    const restore = new URLSearchParams(location.search).get('restore-session');
    const anonymous = new URLSearchParams(location.search).has('anonymous');
    const watchActionsFixture = new URLSearchParams(location.search).has('watch-actions');
    const longCreator = new URLSearchParams(location.search).has('long-creator');
    const homeMix = new URLSearchParams(location.search).has('home-mix');
    const session = { generation: 1, status: anonymous ? 'anonymous' : restore === null ? 'connected' : 'restoring', label: !anonymous && restore === null ? 'Fixture listener' : null, message: null };
    const settings = { theme: 'system', downloadDirectory: 'C:\\Fixture downloads', defaultQuality: 1080, volume: 80, muted: false, playbackRate: 1, alwaysAudioOnly: false, rememberPlaybackMode: false };
    let player = { status: 'idle', video: null, position: 0, duration: 0, volume: 80, muted: false, speed: 1, quality: 1080, requestedQuality: 1080, qualities: [1080, 720, 480], error: null, errorCode: null, bufferedSeconds: 30, loadId: 0, playbackMode: 'video' };
    let callbackId = 0; const callbacks = new Map(); const listeners = new Map();
    const state = { calls: [], bounds: null, context: null, emit: (event, payload) => { for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload }); } };
    state.endVideo = () => { player = {...player,status:'ended',position:player.duration}; state.emit('player-state',player); };
    state.setPlaybackPosition = position => { player = { ...player, position }; state.emit('player-state', player); };
    state.restoreSession = () => {
      Object.assign(session, { status: 'connected', label: 'Fixture listener' });
      state.emit('session-changed', { ...session });
    };
    state.switchSubscriptionAccount = subscribed => {
      channelSubscribed = subscribed;
      Object.assign(session, { generation: session.generation + 1, status: 'connected', label: 'Another fixture listener' });
      state.emit('session-changed', { ...session });
    };
    window.__fixture = state; state.cache = cacheData; state.session = session;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_, id) => listeners.delete(id) };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: handler => { const id = ++callbackId; callbacks.set(id, handler); return id; },
      unregisterCallback: id => callbacks.delete(id),
      invoke: async (command, args = {}) => {
        state.calls.push({ command, args });
        if (command === 'plugin:event|listen') { const id = ++callbackId; listeners.set(id, args); return id; }
        if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
        if (command === 'bootstrap') {
          const snapshot = { ...session };
          if (restore === 'during-bootstrap') await new Promise(resolve => { state.finishBootstrap = resolve; });
          return { session: snapshot, settings, downloads: [], history: [{ video: video(1), duration: video(1).duration, position: 52, updatedAt: Math.floor(Date.now() / 1000) }], tools: [] };
        }
        if (command === 'session_state') return session;
        if (command === 'channel_subscription' || command === 'set_channel_subscription') {
          if (session.status !== 'connected' || args.channelId !== channelProfile.id || args.generation !== session.generation) {
            throw { message: 'Connect your YouTube account to manage subscriptions.' };
          }
          if (command === 'channel_subscription') {
            const code = state.nextSubscriptionReadError;
            state.nextSubscriptionReadError = undefined;
            if (code === 'subscription_status_unavailable') throw { code, message: "Couldn't check subscription status." };
            if (code === 'sign_in_required') throw { code, message: 'Sign in to YouTube to manage channel subscriptions.' };
          } else {
            const code = state.nextSubscriptionWriteError;
            state.nextSubscriptionWriteError = undefined;
            if (code === 'subscription_write_rejected') throw { code, message: "YouTube didn't accept this subscription change." };
            if (state.deferSubscriptionWrite) {
              state.deferSubscriptionWrite = false;
              await new Promise(resolve => { state.finishSubscriptionWrite = resolve; });
              return args.subscribed;
            }
            channelSubscribed = args.subscribed;
            if (code === 'subscription_confirmation_pending') {
              throw { code, message: 'YouTube may have saved this change.' };
            }
          }
          return channelSubscribed;
        }
        if (command === 'local_playlists') return [...(savedLocalPlaylist ? [localCollection] : []), ...(createdPlaylist ? [createdPlaylist] : [])];
        if (command === 'save_local_playlist_video') {
          if (args.title) createdPlaylist = { ...localCollection, id: 'local:evening', title: args.title, itemCount: 1 };
          else if (args.playlistId !== createdPlaylist?.id) throw new Error('Unknown local playlist');
          return;
        }
        if (command === 'youtube_playlist_save') {
          if (anonymous) throw new Error('Connect your account first');
          return args.playlistId ? null : [{ id: 'WL', title: 'Watch later', saved: false }];
        }
        if (command === 'video_channel') return channelProfile.id;
        if (command === 'import_local_playlist') {
          if (!args.link.startsWith('https://www.youtube.com/playlist?list=')) throw { message: 'Paste a YouTube playlist link.' };
          savedLocalPlaylist = true;
          return localCollection;
        }
        if (command === 'local_playlist') return { items: [video(1), video(2), video(3)], nextCursor: null, collection: localCollection };
        if (command === 'remove_local_playlist') { savedLocalPlaylist = false; return; }
        if (command === 'watch_details') return {
          uploadDate: '2026-11-18', viewCount: 49200, likeCount: 1200, rating: anonymous ? null : 'none',
          ...(watchActionsFixture && { channelId: channelProfile.id, channelName: longCreator
            ? 'Nightfall Sessions & the Midnight Orchestra with Coastline Chamber Players'
            : channelProfile.title, channelAvatar: avatar, subscriberCount: 24800 }),
          description: 'A late-night arrangement for piano and strings. Listen for the melody returning in the second half, then follow the quiet transition into the coda.\n\nThanks for listening.',
        };
        if (command === 'rate_video') {
          if (anonymous) throw new Error('A signed-out viewer cannot vote');
          return;
        }
        if (command === 'browse') {
          const status = session.status;
          await new Promise(resolve => setTimeout(resolve, 35));
          if (args.kind === 'home' && status === 'restoring') return { items: [{ ...video(1), title: 'Public Home video' }], nextCursor: null };
          if (args.kind === 'home') {
            const offset = Number(args.cursor ?? 0);
            if (watchActionsFixture && offset && state.failWatchPage) {
              state.failWatchPage = false;
              throw { message: 'Fixture suggestions unavailable' };
            }
            const videos = Array.from({ length: 24 }, (_, i) => {
              const index = i + offset + 1;
              if (!watchActionsFixture || index > 8) return video(index);
              if (index === 1) return { ...sessionVideo(index, 'Nightfall piano session'), channelId: channelProfile.id };
              const tracks = ['Blue hour improvisation', 'A room full of echoes', 'Studio session in D minor', 'After the last train', 'Winter light', 'Quiet arrangements', 'Notes from the coast'];
              return { ...sessionVideo(index, tracks[index - 2]), channel: ['Blue Hour Music', 'Quiet Keys', 'Luna Studio'][(index - 2) % 3] };
            });
            return { items: [...(offset === 0 ? [homeMix ? mix : playlist] : []), ...videos], nextCursor: offset < 48 ? String(offset+24) : null };
          }
          if (channelItems[args.kind] && args.query === channelProfile.id) {
            const items = state.noLiveStreams && args.kind === 'channel-live' ? [] : channelItems[args.kind];
            return { items, channel: channelProfile, nextCursor: null };
          }
          if (args.kind === 'subscriptions') {
            return { items: [{ ...video(15), title: 'Other creator update' }, ...(channelSubscribed ? channelItems['channel-home'].slice(0, 1) : [])], nextCursor: null };
          }
          if (args.kind === 'playlists') return { items: homeMix ? [playlist, liked] : [playlist], nextCursor: null };
          if (args.kind === 'playlist') { const offset = Number(args.cursor ?? 0); if (state.failNextPlaylist && offset > 0) { state.failNextPlaylist = false; throw {message: 'Fixture network interruption'}; } return { items: Array.from({ length: 24 }, (_, i) => video(i+offset+1)), nextCursor: offset < 96 ? String(offset+24) : null, collection: args.query === mix.url ? mixCollection : args.query === liked.url ? likedCollection : collection }; }
          if (args.kind === 'search' && args.query === playlist.title) {
            const piano = { ...video(121), title: 'Soft piano for late nights', channel: 'Quiet Keys' };
            const jazz = { ...video(122), title: 'Late-night instrumental jazz', channel: 'Blue Hour Music' };
            return { items: [playlist, video(3), piano, piano, jazz], nextCursor: 'unused-search-continuation' };
          }
          if (args.kind === 'search' && args.query === 'piano and strings') {
            return { items: Array.from({ length: 12 }, (_, i) => video(i + 40)), nextCursor: null };
          }
          return { items: [video(1)], nextCursor: null };
        }
        if (command === 'cache_summary') return structuredClone(cacheData);
        if (command === 'cache_configure') { cacheData.enabled = args.enabled; cacheData.maxBytes = args.maxBytes; cacheData.content = args.content ?? cacheData.content; state.emit('cache-changed', structuredClone(cacheData)); return structuredClone(cacheData); }
        if (command === 'cache_clear') {
          cacheData.entries = cacheData.entries.filter(file => file.pinned || !(args.entryId ? file.id === args.entryId : args.kind === 'all' || file.mode === args.kind));
          cacheData.audioBytes = cacheData.entries.filter(file => file.mode === 'audio').reduce((sum,file) => sum+file.bytes,0);
          cacheData.videoBytes = cacheData.entries.filter(file => file.mode === 'video').reduce((sum,file) => sum+file.bytes,0);
          cacheData.pendingBytes = 0; cacheData.activeCount = 0; cacheData.totalBytes = cacheData.audioBytes + cacheData.videoBytes; cacheData.entryCount = cacheData.entries.length;
          cacheData.activeCount = 0; state.emit('cache-changed', structuredClone(cacheData)); return structuredClone(cacheData);
        }
        if (command === 'video_comments') {
          await new Promise(resolve => setTimeout(resolve,30));
          if (args.parentId) return { videoId: args.videoId, parentId: args.parentId, sort: args.sort, disabled: false,
            totalCount: null, nextCursor: args.cursor ? null : 'replies-next', items: [{
              id: args.cursor ? 'reply-2' : 'reply-1', author: args.cursor ? 'Evening listener' : 'Coastline listener',
              authorChannelId: channelProfile.id, authorThumbnail: avatar, text: args.cursor ? 'The strings are a lovely touch.' : 'I love that piano section too.',
              likeCount: 3, replyCount: null, published: '1 day ago', authorIsUploader: false, isPinned: false,
            }] };
          if (args.videoId === 'fixture-5') return { videoId: args.videoId, items: [], nextCursor: null, totalCount: null, disabled: true, sort: args.sort, limited: false };
          const start = args.cursor ? 20 : 0; const count = args.sort === 'newest' ? 2 : args.cursor ? 3 : 20;
          return { videoId: args.videoId, items: Array.from({ length: count },(_,index) => ({ id: `${args.videoId}-${args.sort}-${start+index}`, author: args.sort === 'newest' ? `Newest viewer ${index+1}` : `Viewer ${start+index+1}`, authorChannelId: start+index===1 ? 'UC1234567890123456789012' : null, authorThumbnail: start+index===1 ? art : null, text: start+index===0 ? 'Literal <script>window.__commentInjected=true</script> stays plain text. '+('A thoughtful comment about this video. '.repeat(15)) : start+index===1 ? '1:21 est mon passage préféré. La mélodie continue de me surprendre.' : `A comment on this video, number ${start+index+1}.`, likeCount: index*3, replyCount: index===1?2:null, published: '2 days ago', authorIsUploader: index===1, isPinned: index===0 && args.sort==='top' })), nextCursor: args.sort==='top'&&!args.cursor?'comments-next':null, totalCount:23, disabled:false, sort:args.sort, limited:false };
        }
        if (command === 'cancel_comments') return;
        if (command === 'translate_comment') return '1:21 is my favorite part. The melody still surprises me.';
        if (command === 'player_overlay_snapshot') return {revision:1,player,ui:{hasPrevious:false,hasNext:true,mini:false,theater:false,fullscreen:false},pausedIntent:player.status==='paused',overlayError:null};
        if (command === 'player_state') return player;
        if (command === 'play_video') { if (settings.rememberPlaybackMode && args.playbackMode) player.preferredPlaybackMode = args.playbackMode;
          player = { ...player, video: args.item, status: 'playing', loadId: player.loadId + 1, position: 0, duration: args.item.duration, playbackMode: args.playbackMode ?? player.preferredPlaybackMode ?? player.playbackMode,
          storyboard: args.item.chapters && {urlTemplate:'https://i.ytimg.com/sb/timeline-fixture/M$M.jpg',width:160,height:90,columns:2,rows:2,frameCount:8,frameDuration:40} }; state.emit('player-state', player); return; }
        if (command === 'player_overlay_action') { if(args.action==='adjust-volume') player={...player,volume:Math.max(0,Math.min(100,player.volume+args.value))}; else if (args.action === 'seek' && args.loadId === player.loadId) player = { ...player, position: args.value }; state.emit('player-state',player); return; }
        if (command === 'player_action') { if (args.action === 'toggle') player = { ...player, status: player.status === 'playing' ? 'paused' : 'playing' }; else if (args.action === 'speed') player = { ...player, speed: args.value }; else if (args.action === 'stop') player = { ...player, status: 'idle', video: null }; state.emit('player-state', player); return; }
        if (command === 'set_playback_mode') { player = { ...player, playbackMode: args.mode, preferredPlaybackMode: settings.rememberPlaybackMode ? args.mode : undefined }; state.emit('player-state', player); return; }
        if (command === 'player_ui_context') { state.context = args.context; return; }
        if (command === 'player_bounds') { state.bounds = args.bounds; return; }
        if (command === 'save_settings') {
          if (settings.rememberPlaybackMode !== args.settings.rememberPlaybackMode) {
            player = { ...player, preferredPlaybackMode: args.settings.rememberPlaybackMode ? player.playbackMode : undefined };
            state.emit('player-state', player);
          }
          Object.assign(settings, args.settings); return settings;
        }
        if (command === 'retry_player_overlay') return;
        if (command === 'clear_history' || command === 'cancel_browse' || command.startsWith('plugin:window|')) return;
        throw new Error(`Unimplemented fixture command: ${command}`);
      },
    };
  });
  const calls = async kind => page.evaluate(name => window.__fixture.calls.filter(call=>call.command==='browse'&&call.args.kind===name),kind);
  const waitCount = async (kind,count) => page.waitForFunction(({kind,count})=>window.__fixture.calls.filter(call=>call.command==='browse'&&call.args.kind===kind).length===count,{kind,count});
  await page.goto('http://127.0.0.1:1423/?restore-session');
  const publicVideo = page.getByRole('button', { name: 'Play Public Home video', exact: true });
  await publicVideo.waitFor();
  check('Saved session shows checking status while public Home loads', await page.getByRole('status').filter({ hasText: 'Checking YouTube sign-in' }).isVisible() && await page.getByRole('button', { name: /^(Sign in|Account sign-in)$/ }).count() === 0);
  await page.evaluate(() => window.__fixture.restoreSession());
  await page.getByRole('button', { name: 'Connected account' }).waitFor();
  await page.getByRole('button', { name: 'Open Evening listening', exact: true }).waitFor();
  await page.evaluate(() => window.__fixture.restoreSession());
  await page.waitForTimeout(100);
  check('Same-generation sign-in refreshes Home once with a personalized feed', await publicVideo.count() === 0 && (await calls('home')).length === 2);

  await page.goto('http://127.0.0.1:1423/?restore-session=during-bootstrap');
  await page.waitForFunction(() => typeof window.__fixture.finishBootstrap === 'function');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.evaluate(() => {
    window.__fixture.restoreSession();
    window.__fixture.finishBootstrap();
  });
  await page.getByRole('button', { name: 'Manage sign-in', exact: true }).waitFor();
  await waitCount('home', 1);
  check('Sign-in during bootstrap refreshes Home without leaving Settings', await page.getByRole('heading', { name: 'Settings', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Open Evening listening', exact: true }).waitFor();
  check('Home reuses the updated feed when the user returns', (await calls('home')).length === 1);

  await page.goto('http://127.0.0.1:1423', { waitUntil: 'load' });
  await page.getByRole('button',{name:'Open Evening listening',exact:true}).waitFor();
  await page.waitForTimeout(180);
  check('Outer document scrollbar is hidden without disabling overflow', await page.locator('html').evaluate(el=>getComputedStyle(el).scrollbarWidth==='none'&&getComputedStyle(el).overflowY!=='hidden'));
  check('Home initially requests one page', (await calls('home')).length===1&&await page.locator('.video-card').count()===25);
  await page.locator('.scroll-loader').scrollIntoViewIfNeeded();await waitCount('home',2);await page.waitForFunction(()=>document.querySelectorAll('.video-card').length===48);
  await page.waitForTimeout(180);
  check('Home scroll fetches exactly one continuation', (await calls('home')).length===2);
  await page.locator('.scroll-loader').scrollIntoViewIfNeeded();await waitCount('home',3);await page.waitForFunction(()=>document.querySelectorAll('.video-card').length===72);
  check('Home successive bottom scroll loads the next page', (await calls('home')).length===3&&await page.locator('.scroll-loader').count()===0);
  check('Header Home shortcut is removed while sidebar Home remains',await page.locator('.header-home').count()===0&&await page.getByRole('button',{name:'Home',exact:true}).count()===1);
  const circle=await page.locator('.search-submit').evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {w:r.width,h:r.height,radius:s.borderRadius};});
  check('Search submit is a separate 46px circular accessible button',circle.w===46&&circle.h===46&&circle.radius==='50%');
  await page.getByRole('button',{name:'Back to top',exact:true}).waitFor();await page.getByRole('button',{name:'Back to top',exact:true}).click();await page.waitForFunction(()=>scrollY<2);
  check('Home back-to-top returns to the heading without reloading pages',await page.locator('.video-card').count()===72&&(await calls('home')).length===3&&await page.getByRole('heading',{name:'Home',exact:true}).evaluate(el=>document.activeElement===el));
  await page.getByRole('button',{name:'Playlists',exact:true}).click();await page.getByRole('button',{name:'View full playlist',exact:true}).click();
  await page.getByRole('heading',{name:'Evening listening',exact:true}).waitFor();await page.waitForTimeout(160);
  check('Playlist initially displays only 24 items',await page.locator('.playlist-row').count()===24&&(await calls('playlist')).length===1);
  await page.locator('.playlist-videos .scroll-loader').scrollIntoViewIfNeeded();await waitCount('playlist',2);await page.waitForFunction(()=>document.querySelectorAll('.playlist-row').length===48);await page.waitForTimeout(160);
  check('Playlist scroll loads only next page',await page.locator('.playlist-row').count()===48&&(await calls('playlist')).length===2);
  await page.getByRole('button',{name:'Back to top',exact:true}).waitFor();await page.getByRole('button',{name:'Back to top',exact:true}).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>scrollY<2);
  check('Playlist back-to-top works by keyboard and retains loaded videos',await page.locator('.playlist-row').count()===48&&(await calls('playlist')).length===2);
  await page.getByRole('button',{name:'Play Fixture video 03 from this playlist',exact:true}).click();await page.getByRole('region',{name:'Comments',exact:true}).waitFor();await page.waitForTimeout(180);
  check('Playing a playlist does not drain remaining pages',await page.locator('.queue-item').count()===48&&(await calls('playlist')).length===2);
  const translatedComment = page.locator('.comment-row').filter({ hasText: 'est mon passage préféré' });
  const replies = translatedComment.locator('.comment-replies');
  const replyToggle = translatedComment.getByRole('button', { name: '2 replies', exact: true });
  await replyToggle.waitFor();
  check('Comment authors use the normal text color and replies load on demand',
    await translatedComment.locator('.comment-author-link').evaluate(el => getComputedStyle(el).color === getComputedStyle(el.closest('.comment-row')).color)
    && await page.evaluate(() => !window.__fixture.calls.some(call => call.command === 'video_comments' && call.args.parentId)));
  await replyToggle.click();
  await replies.getByText('I love that piano section too.').waitFor();
  await replies.getByRole('button', { name: 'More replies', exact: true }).click();
  await replies.getByText('The strings are a lovely touch.').waitFor();
  check('Show replies loads and paginates the selected comment thread', await replies.locator('.comment-row').count() === 2
    && await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'video_comments' && call.args.parentId)
      .every(call => call.args.parentId === 'duplicate-id-top-1')));
  await page.mouse.move(0, 0);
  await translatedComment.screenshot({ path: path.join(output, 'viewsical-comment-replies.png') });
  await translatedComment.getByRole('button', { name: 'Hide replies', exact: true }).click();
  check('Hiding replies collapses the thread', !await replies.isVisible());
  await translatedComment.getByRole('button', { name: 'Translate to English' }).click();
  const translatedText = page.getByText('is my favorite part. The melody still surprises me.');
  await translatedText.waitFor();
  const translationRow = page.locator('.comment-row').filter({ hasText: 'The melody still surprises me.' });
  const showOriginal = translationRow.getByRole('button', { name: 'Show original' });
  await showOriginal.click();
  await translatedComment.getByRole('button', { name: 'Translate to English' }).click();
  await translatedText.waitFor();
  check('Comment translation can display the original and reuse its English translation', await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'translate_comment').length === 1));
  await page.mouse.move(0, 0);
  await showOriginal.evaluate(el => el.blur());
  await translationRow.evaluate(el => el.scrollIntoView({ block: 'center' }));
  const commentBox = await translationRow.boundingBox();
  await page.screenshot({ path: path.join(output, 'viewsical-comment-translation.png'), clip: {
    x: Math.floor(commentBox.x - 12), y: Math.floor(commentBox.y - 12), width: Math.ceil(commentBox.width + 24), height: Math.ceil(commentBox.height + 24),
  } });
  await translationRow.getByRole('button', { name: 'Jump to 1:21' }).press('Enter');
  await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'player_overlay_action' && call.args.action === 'seek' && call.args.loadId > 0 && call.args.value === 81));
  await page.waitForFunction(() => scrollY === 0);
  check('Keyboard activation of a translated comment timestamp seeks the active playlist item', await page.locator('.queue-item.current strong').textContent() === 'Fixture video 03');
  const suggestions = page.getByRole('region', { name: 'More to watch', exact: true });
  await suggestions.getByRole('button', { name: 'Add Fixture video 49 to queue', exact: true }).waitFor();
  check('The playlist sidebar shows extra Home videos below its queue',
    await page.locator('.queue-panel + .recommendations').count() === 1
    && await suggestions.locator('.recommendation').count() === 8
    && await suggestions.getByRole('button', { name: 'Add Fixture video 03 to queue', exact: true }).count() === 0
    && (await calls('home')).length === 3 && (await calls('search')).length === 0);
  const queueScroll=page.locator('.queue-list');const rootBeforeQueueWheel=await page.evaluate(()=>scrollY);await queueScroll.hover();await page.mouse.wheel(0,180);await page.waitForTimeout(120);check('Internal queue keeps its independent visible scrollbar and wheel scrolling',await queueScroll.evaluate(el=>getComputedStyle(el).scrollbarWidth==='thin'&&el.scrollTop>0)&&await page.evaluate(()=>scrollY)===rootBeforeQueueWheel);
  await page.locator('.queue-list').evaluate(el=>{el.scrollTop=el.scrollHeight;});await waitCount('playlist',3);await page.waitForFunction(()=>document.querySelectorAll('.queue-item').length===72);await page.waitForTimeout(180);
  check('Queue bottom scroll requests one page and stops',await page.locator('.queue-item').count()===72&&(await calls('playlist')).length===3);
  check('Repeated video IDs remain distinct playlist occurrences',await page.locator('.queue-item strong').allTextContents().then(names=>names.includes('Fixture video 03')&&names.includes('Fixture video 28')));
  await page.evaluate(()=>{window.__fixture.failNextPlaylist=true;});await page.locator('.queue-list').evaluate(el=>{el.scrollTop=el.scrollHeight;});await waitCount('playlist',4);await page.getByText('Fixture network interruption',{exact:true}).waitFor();await page.waitForTimeout(200);
  check('Continuation error does not retry in a loop',(await calls('playlist')).length===4);
  await page.getByRole('button',{name:'Retry playlist loading',exact:true}).click();await waitCount('playlist',5);await page.waitForFunction(()=>document.querySelectorAll('.queue-item').length===96);
  check('Explicit retry loads one page preserving queue selection',await page.locator('.queue-item.current strong').textContent()==='Fixture video 03'&&await page.locator('.queue-item').count()===96);
  await page.getByRole('button',{name:/Fixture video 96 Fixture Music/}).click();await waitCount('playlist',6);await page.waitForFunction(()=>document.querySelectorAll('.queue-item').length===120);await page.waitForTimeout(160);
  check('Playback near loaded end obtains only the needed next page',await page.locator('.queue-item.current strong').textContent()==='Fixture video 96'&&(await calls('playlist')).length===6);
  await page.getByRole('button',{name:/Fixture video 120 Fixture Music/}).click();const countBefore=(await calls('playlist')).length;check('Last playlist item disables Next',await page.locator('.accessible-controls [aria-label="Next video"]').isDisabled());
  check('Watch page omits the keyboard controls button', await page.getByRole('button', { name: 'Keyboard controls', exact: true }).count() === 0);
  await page.locator('.sidebar-bottom button').focus();
  await page.keyboard.press('Tab');
  check('Tab reveals the accessible playback controls', await page.locator('.accessible-controls:focus-within').count() === 1);
  await page.keyboard.press('Shift+Tab');
  check('Accessible playback controls collapse when focus leaves', await page.locator('.accessible-controls').evaluate(element => element.getBoundingClientRect().height === 1));
  check('Exhausted playlist stops requesting pages',(await calls('playlist')).length===countBefore&&await page.locator('.queue-list .scroll-loader').count()===0);
  const addPiano = suggestions.getByRole('button', { name: 'Add Soft piano for late nights to queue', exact: true });
  await addPiano.waitFor();
  const suggestionSearches = await calls('search');
  check('A playlist reuses one bounded search when Home only contains queued videos',
    await suggestions.locator('.recommendation').count() === 2 && suggestionSearches.length === 1
    && suggestionSearches[0].args.query === 'Evening listening' && suggestionSearches[0].args.cursor === null);
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  const playlistSidebar = await page.locator('.watch-aside').boundingBox();
  await page.screenshot({ path: path.join(output, 'playlist-recommendations.png'), clip: {
    x: Math.floor(playlistSidebar.x - 10), y: Math.floor(playlistSidebar.y + 34),
    width: Math.ceil(playlistSidebar.width + 20), height: 626,
  } });
  await addPiano.click();
  check('Adding a suggestion keeps the current playlist and selection',
    await page.locator('.queue-panel h2').textContent() === 'Evening listening'
    && await page.locator('.queue-item.current strong').textContent() === 'Fixture video 120'
    && await page.locator('.queue-item').count() === 121 && await addPiano.count() === 0);
  await page.getByRole('button', { name: 'Remove Soft piano for late nights from queue', exact: true }).click();
  await page.locator('.queue-list').getByRole('button',{name:/Fixture video 119 Fixture Music/}).click();
  await page.getByRole('button',{name:'Listen with audio only',exact:true}).click();
  await page.evaluate(()=>window.__fixture.endVideo());
  await page.waitForFunction(()=>document.querySelector('.queue-item.current strong')?.textContent==='Fixture video 120');
  const startsAtQueueEnd = await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='play_video').length);
  await page.evaluate(()=>window.__fixture.endVideo());
  await page.locator('.full-player .player-surface').hover();
  await page.getByRole('button',{name:'Play (Space)',exact:true}).waitFor();
  check('Final audio item stops with replay available and no error',await page.locator('.player-error').count()===0&&await page.getByRole('button',{name:'Next video',exact:true}).isDisabled()&&await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='play_video').length)===startsAtQueueEnd);
  const audioSeek = page.getByRole('slider',{name:'Playback position'});
  check('Audio-only controls show no video resolution', await page.locator('.full-player .player-current-quality').count() === 0);
  check('Audio progress shows the replay distribution and its accessible peak',await page.locator('.full-player .seek-heatmap').isVisible()&&await audioSeek.evaluate(el=>document.getElementById(el.getAttribute('aria-describedby'))?.textContent==='Most replayed around 1:15'));
  await audioSeek.press('ArrowLeft');
  check('Keyboard seeking still works with replay data',await page.evaluate(()=>window.__fixture.calls.some(call=>call.command==='player_action'&&call.args.action==='seek'&&call.args.value===309.9)));
  await scrubAt(page, audioSeek, 0.25);
  await page.locator('.full-player .seek-preview-time').waitFor();
  check('Audio-only mode keeps chapter divisions and uses a text-only seek preview',
    await page.locator('.full-player .seek-chapter-segment').count()===2
    && await page.locator('.full-player .seek-chapter-segment.is-active').count()===1
    && await page.locator('.full-player .seek-preview-chapter').textContent()==='Overture'
    && await page.locator('.full-player .seek-preview-image').count()===0);
  await audioSeek.blur();
  await scrubAt(page, audioSeek, 0.53);
  await page.locator('.full-player .seek-preview-chapter').getByText('Main theme', { exact: true }).waitFor();
  await timelineScreenshot(page, audioSeek, 'timeline-hover-audio.png', 125);
  await page.locator('.full-player .audio-overlay-controls').getByRole('button', { name: 'Minimize player', exact: true }).click();
  await page.getByRole('heading',{name:'Evening listening',exact:true}).waitFor();
  check('Queue loading shares cached playlist pages without duplication',await page.locator('.playlist-row').count()===120&&(await calls('playlist')).length===6);
  await page.getByRole('button',{name:'Home',exact:true}).click();await page.getByRole('heading',{name:'Home',exact:true}).waitFor();
  check('Home loaded pages survive navigation without reload',await page.locator('.video-card').count()===72&&(await calls('home')).length===3);
  await page.locator('.mini-player .player-surface').hover();
  check('Floating audio player keeps its footer Expand player control',await page.getByRole('button',{name:'Expand player',exact:true}).isVisible()&&await page.locator('.mini-player .player-surface button[aria-label*="fullscreen" i]').count()===0);
  const miniGraph = page.locator('.mini-player .seek-heatmap');
  await miniGraph.waitFor({state:'visible'});
  check('Floating audio player shows a compact replay heatmap',await miniGraph.evaluate(el=>el.getBoundingClientRect().height===19));
  await scrubAt(page, page.locator('.mini-player .seek-slider'), 0.9);
  const miniPreview = page.locator('.mini-player .seek-preview');
  await miniPreview.locator('.seek-preview-time').waitFor();
  const miniStage = await page.locator('.mini-player .player-surface').boundingBox();
  const miniPreviewBox = await miniPreview.boundingBox();
  check('Floating audio player keeps text-only chapter previews inside the surface',
    miniPreviewBox.y>=miniStage.y && miniPreviewBox.x+miniPreviewBox.width<=miniStage.x+miniStage.width
    && await miniPreview.locator('.seek-preview-chapter').textContent()==='Main theme'
    && await miniPreview.locator('.seek-preview-image').count()===0
    && await miniPreview.locator('.seek-preview-caption').evaluate(el => getComputedStyle(el).backdropFilter === 'none'));
  await page.getByRole('button',{name:'Move player to bottom bar',exact:true}).click();
  const dockedGraph = page.locator('.bottom-player-progress .seek-heatmap');
  await dockedGraph.waitFor({state:'visible'});
  check('Docked player aligns the replay heatmap to its own progress bar',await dockedGraph.evaluate(el=>Math.abs(el.getBoundingClientRect().bottom-el.parentElement.querySelector('input').getBoundingClientRect().top)<0.5));
  await scrubAt(page, page.locator('.bottom-player-progress .seek-slider'), 0.1);
  await page.locator('.bottom-player-progress .seek-preview-time').waitFor();
  const dockPreview = await page.locator('.bottom-player-progress .seek-preview').boundingBox();
  const dock = await page.locator('.bottom-player').boundingBox();
  check('Docked audio player shows the chapter above its timeline without a thumbnail',
    dockPreview.y<dock.y && await page.locator('.bottom-player-progress .seek-preview-chapter').textContent()==='Overture'
    && await page.locator('.bottom-player-progress .seek-preview-image').count()===0);
  await page.waitForTimeout(120);
  check('Audio-only seeking does not request storyboard images',images.length===0,images);
  const dockOptions = page.locator('.bottom-player-options');
  async function setDockMode(mode) {
    await dockOptions.getByRole('button', { name: 'Playback settings' }).click();
    await dockOptions.getByRole('menuitem', { name: /Playback mode/ }).click();
    await dockOptions.getByRole('menuitemradio', { name: mode, exact: true }).click();
  }
  await setDockMode('Video');
  await page.locator('.bottom-player:not(.audio-player)').waitFor();
  const dockToast = page.getByRole('button', { name: 'Dismiss message' });
  if (await dockToast.isVisible()) await dockToast.click();
  const dockSlider = page.locator('.bottom-player-progress .seek-slider');
  await scrubAt(page, dockSlider, 0.25);
  await page.locator('.bottom-player-progress .seek-preview-time').waitFor();
  await page.waitForTimeout(120);
  check('Docked video keeps the hover time and chapter without requesting a storyboard',
    await page.locator('.bottom-player-progress .seek-preview-chapter').textContent() === 'Overture'
    && await page.locator('.bottom-player-progress .seek-preview-image').count() === 0 && images.length === 0);
  check('Bottom player uses translucent glass behind the chapter and time',
    await page.locator('.bottom-player-progress .seek-preview-caption').evaluate(el => {
      const { backgroundColor, backdropFilter } = getComputedStyle(el);
      return backdropFilter.includes('blur(') && backgroundColor.includes('/ 0.76');
    }));
  const screenshotTop = Math.floor(dock.y - 70);
  await page.screenshot({ path: path.join(output, 'viewsical-bottom-player-no-thumbnail.png'),
    clip: { x: 0, y: screenshotTop, width: page.viewportSize().width, height: page.viewportSize().height - screenshotTop } });
  await setDockMode('Audio only');
  await page.getByRole('button',{name:'Restore floating mini player',exact:true}).click();
  await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});await page.mouse.move(950,500);await page.mouse.wheel(0,600);await page.waitForTimeout(120);check('Root wheel scrolling works with no visible page scrollbar',await page.evaluate(()=>scrollY)>0);const yBeforePageUp=await page.evaluate(()=>scrollY);await page.keyboard.press('PageUp');await page.waitForFunction(previous=>scrollY<previous,yBeforePageUp,{timeout:5000});check('Root PageUp retains document scrolling',await page.evaluate(()=>scrollY)<yBeforePageUp);await page.keyboard.press('End');await page.waitForFunction(()=>scrollY+innerHeight>=document.documentElement.scrollHeight-2,{},{timeout:5000});check('Root End key reaches loaded page bottom',await page.evaluate(()=>scrollY+innerHeight>=document.documentElement.scrollHeight-2));await page.keyboard.press('Home');await page.waitForFunction(()=>scrollY<2,undefined,{timeout:5000});check('Root Home key returns to top',await page.evaluate(()=>scrollY)<2);
  await page.evaluate(()=>scrollTo(0,600));await page.getByRole('button',{name:'Back to top',exact:true}).waitFor();
  const topBox=await page.locator('.back-to-top').boundingBox(),miniBox=await page.locator('.mini-player').boundingBox();
  check('Back-to-top remains separated from the floating mini player',topBox&&miniBox&&topBox.x+topBox.width+12<=miniBox.x);
  await page.evaluate(()=>scrollTo(0,300));await page.waitForTimeout(80);const savedY=await page.evaluate(()=>scrollY);await page.getByRole('button',{name:'Downloads',exact:true}).click();await page.getByRole('button',{name:'Home',exact:true}).click();await page.waitForTimeout(180);check('Saved Home scroll position survives navigation with hidden scrollbar',Math.abs((await page.evaluate(()=>scrollY))-savedY)<2);
  await page.locator('.sidebar-bottom').getByRole('button',{name:'Settings',exact:true}).click();
  const rememberMode = page.getByRole('switch', { name: 'Remember playback mode' });
  const alwaysAudio = page.getByRole('switch', { name: 'Always start with audio only' });
  check('Remember playback mode starts off', await rememberMode.getAttribute('aria-checked') === 'false');
  await alwaysAudio.click();
  await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'save_settings' && call.args.settings.alwaysAudioOnly));
  await rememberMode.click();
  await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'save_settings' && call.args.settings.rememberPlaybackMode && !call.args.settings.alwaysAudioOnly));
  check('Remember playback mode replaces the forced audio default', await rememberMode.getAttribute('aria-checked') === 'true' && await alwaysAudio.getAttribute('aria-checked') === 'false');
  await page.locator('.sidebar-bottom').getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('light');await page.waitForTimeout(50);check('Light theme retains hidden outer scrollbar',await page.locator('html').evaluate(el=>el.dataset.theme==='light'&&getComputedStyle(el).scrollbarWidth==='none'));await page.screenshot({path:path.join(output,'v017-browser-light-settings.png')});await page.getByRole('combobox',{name:'Theme',exact:true}).selectOption('dark');await page.getByRole('button',{name:'Home',exact:true}).click();
  await page.screenshot({path:path.join(output,'v017-browser-scrolling-home.png')});
  await page.getByRole('button',{name:'History',exact:true}).click();
  await page.getByRole('button',{name:'Play Fixture video 01',exact:true}).click();
  const historyPlay = await page.evaluate(()=>window.__fixture.calls.filter(call=>call.command==='play_video').at(-1).args);
  check('History opens a fresh item even with a legacy saved position',historyPlay.item.id==='fixture-1'&&!('startSeconds' in historyPlay));
  check('Opening a new item uses the remembered audio mode', historyPlay.playbackMode === null && await page.locator('.full-player .audio-stage').isVisible());
  await page.locator('.full-player .seek-slider').waitFor({state:'attached'});
  check('A video without replay data keeps the plain seek bar',await page.locator('.full-player .seek-slider').count()===1&&await page.locator('.full-player .seek-heatmap').count()===0);
  const audioMode = page.getByRole('button', { name: 'Listen with audio only', exact: true });
  if (await audioMode.isVisible()) await audioMode.click();
  await page.locator('.full-player .player-surface').hover();
  const plainSlider = page.locator('.full-player .seek-slider');
  const plainSamples = [0.16, 0.80];
  const plainIdle = await railPixels(page, plainSlider, plainSamples);
  await scrubAt(page, plainSlider, 0.25);
  await page.locator('.full-player .seek-preview-time').waitFor();
  check('Without chapter or storyboard data, hover still shows just the time',
    await page.locator('.full-player .seek-preview-time').isVisible() && await page.locator('.full-player .seek-preview img, .full-player .seek-chapter-segment').count()===0);
  const plainHover = await railPixels(page, plainSlider, plainSamples);
  check('A timeline without chapters also brightens only before the pointer',
    plainHover[0][1] > plainIdle[0][1] + 12 && plainHover[1].every((channel, index) => channel === plainIdle[1][index]));
  await page.getByRole('button', { name: 'Switch to video', exact: true }).click();
  await page.getByRole('button', { name: 'Listen with audio only', exact: true }).waitFor();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'Play Fixture video 01', exact: true }).click();
  check('An explicit switch to video becomes the new default', await page.getByRole('button', { name: 'Listen with audio only', exact: true }).isVisible()
    && (await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'play_video').at(-1).args.playbackMode)) === null);
  await testWatchDetails(page, check);
  await page.goto('http://127.0.0.1:1423/?anonymous');
  await page.getByRole('button', { name: 'Play Fixture video 01', exact: true }).click();
  check('Signed-out viewers can share while both rating controls are disabled',
    await page.getByRole('button', { name: 'Like', exact: true }).isDisabled()
    && await page.getByRole('button', { name: 'Dislike', exact: true }).isDisabled()
    && await page.getByRole('button', { name: 'Share', exact: true }).isEnabled());
  const author = page.getByRole('button', { name: 'Viewer 2', exact: true });
  const profileAvatar = page.getByRole('button', { name: "Open Viewer 2's profile", exact: true });
  await author.waitFor();
  check('Comment authors without a channel ID stay plain text',
    await page.locator('.comment-author strong').filter({ hasText: /^Viewer 1$/ }).isVisible());
  const startsBeforeProfile = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'play_video').length);
  await author.press('Enter');
  const channelTitle = page.getByRole('heading', { name: 'Nightfall Sessions', exact: true });
  await channelTitle.waitFor();
  await page.getByRole('button', { name: 'Play Nightfall piano session', exact: true }).waitFor();
  const channelTabs = page.getByRole('tablist', { name: 'Channel sections' });
  const channelTab = name => channelTabs.getByRole('tab', { name, exact: true });
  check('A signed-out viewer opens the channel Home from a comment by keyboard',
    (await calls('channel-home')).length === 1
    && (await calls('channel-home'))[0].args.query === 'UC1234567890123456789012'
    && await channelTab('Home').getAttribute('aria-selected') === 'true');
  check('The profile shows the fetched identity and exactly four tabs',
    await page.getByText('@nightfallsessions', { exact: true }).isVisible()
    && (await channelTabs.getByRole('tab').allTextContents()).map(label => label.trim()).join('|') === 'Home|Videos|Live|Playlists');
  const signedOutProfile = page.getByRole('region', { name: 'Nightfall Sessions', exact: true });
  const signedOutSubscribe = signedOutProfile.getByRole('button', { name: 'Subscribe', exact: true });
  check('Signed-out viewers see Subscribe but cannot change a subscription',
    await signedOutSubscribe.isDisabled()
    && await signedOutSubscribe.getAttribute('title') === 'Sign in to YouTube to subscribe'
    && await page.evaluate(() => !window.__fixture.calls.some(call => call.command === 'channel_subscription' || call.command === 'set_channel_subscription')));
  check('The profile uses the global navigation Back control',
    await signedOutProfile.getByRole('button', { name: 'Back', exact: true }).count() === 0
    && await page.locator('.topbar').getByRole('button', { name: 'Go back', exact: true }).isEnabled());
  await page.screenshot({ path: path.join(output, 'viewsical-channel-signed-out.png'), clip: { x: 244, y: 68, width: 1232, height: 560 } });
  check('Channel tabs load on demand', (await calls('channel')).length === 0
    && (await calls('channel-live')).length === 0 && (await calls('channel-playlists')).length === 0);
  await channelTab('Home').press('ArrowRight');
  check('Arrow keys move focus between channel tabs', await channelTab('Videos').evaluate(tab => tab === document.activeElement));
  if (await channelTab('Videos').getAttribute('aria-selected') !== 'true') await channelTab('Videos').press('Enter');
  await page.getByRole('button', { name: 'Play Moonrise over the keys', exact: true }).waitFor();
  check('Keyboard navigation opens the Videos tab and its own items',
    await channelTab('Videos').getAttribute('aria-selected') === 'true'
    && await page.getByRole('tabpanel', { name: 'Videos', exact: true }).isVisible()
    && (await calls('channel')).length === 1
    && await page.getByRole('button', { name: 'Play Nightfall piano session', exact: true }).count() === 0);
  await channelTab('Live').click();
  await page.getByRole('button', { name: 'Play Late-night studio livestream', exact: true }).waitFor();
  check('Live shows stream entries from its own tab',
    await channelTab('Live').getAttribute('aria-selected') === 'true' && (await calls('channel-live')).length === 1);
  await channelTab('Playlists').click();
  const channelPlaylist = page.getByRole('button', { name: 'View full playlist', exact: true });
  await channelPlaylist.waitFor();
  check('Playlists shows collections from the channel', await channelTab('Playlists').getAttribute('aria-selected') === 'true'
    && (await calls('channel-playlists')).length === 1);
  await channelPlaylist.click();
  await page.getByRole('heading', { name: 'Evening listening', exact: true }).waitFor();
  await page.locator('.page-heading').getByRole('button', { name: 'Back', exact: true }).click();
  await channelTab('Playlists').waitFor();
  check('Back from a playlist restores its channel tab', await channelTab('Playlists').getAttribute('aria-selected') === 'true');
  await channelTab('Videos').click();
  await page.getByRole('button', { name: 'Play Moonrise over the keys', exact: true }).waitFor();
  check('Revisiting a channel tab reuses its cached entries', (await calls('channel')).length === 1);
  await page.locator('.topbar').getByRole('button', { name: 'Go back', exact: true }).click();
  await author.waitFor();
  await profileAvatar.click();
  await channelTitle.waitFor();
  check('The avatar opens the same cached profile and Back retains playback',
    (await calls('channel-home')).length === 1 && await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'play_video').length) === startsBeforeProfile);
  await page.getByRole('button', { name: 'Close player', exact: true }).click();
  await channelTab('Videos').click();
  await page.getByRole('button', { name: 'Play Moonrise over the keys', exact: true }).waitFor();
  const artwork = await page.locator('img').evaluateAll(images => images
    .filter(image => image.complete && image.naturalWidth > 0)
    .map(image => ({ naturalWidth: image.naturalWidth, width: image.getBoundingClientRect().width })));
  check('The channel banner and large profile picture are rendered',
    artwork.some(image => image.naturalWidth === 1200 && image.width > 600)
    && artwork.some(image => image.naturalWidth === 256 && image.width >= 120), artwork);
  await page.evaluate(() => { window.__fixture.noLiveStreams = true; });
  await channelTab('Live').click();
  await page.getByRole('button', { name: 'Refresh channel', exact: true }).click();
  await page.getByRole('heading', { name: 'No public live streams', exact: true }).waitFor();
  check('An empty Live tab keeps the channel profile visible',
    (await calls('channel-live')).length === 2 && await channelTitle.isVisible());
  await testChannelSubscription(page, check);
  await page.goto('http://127.0.0.1:1423/?anonymous');
  await testLocalPlaylists(page, check);
  await testWatchActions(page, check);
  await testWatchActionOverflow(page, check);
  await testHomeCreatorAndMix(page, check);
  await testSubscriptionRecovery(page, check);
  await testNavigationLayout(page, check);
  await testCacheContent(page, check);
  await scaledOverlayChecks(browser,output,check);
  check('No browser errors',errors.length===0,errors);
} catch(error) {
  await browser.contexts()[0]?.pages()[0]?.screenshot({path:path.join(output,'v017-browser-failure.png')});
  results.push({name:'Scroll checks completed',passed:false,detail:String(error)});process.exitCode=1;
} finally {
  const summary={passed:results.every(result=>result.passed),checks:results};await writeFile(path.join(output,'v017-browser-results.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({passed:summary.passed,checks:results.length,failures:results.filter(r=>!r.passed)}));await browser.close();await new Promise(resolve=>server.httpServer.close(resolve));
}
