import assert from 'node:assert/strict';
import test from 'node:test';
import { musicBrowserCategories, videoCategories, visibleCategories } from '../src/components/BrowserCategories.ts';
import { getPipBounds } from '../src/components/PipPosition.ts';
import { collectionResumes, episodeLabel, insertNextEpisode, queueFromEpisode, resumeEpisode } from '../src/components/VideoQueue.ts';

test('browser layouts hide and reorder categories while retaining new entries', () => {
  const categories = musicBrowserCategories(false);
  const layout = { order: ['tracks', 'missing', 'tracks'], hidden: ['albums'] };
  assert.deepEqual(visibleCategories(categories, layout).map(({ key }) => key), ['tracks', 'artists', 'recentlyAdded']);
});

test('only account connections get a Watchlist alongside video libraries', () => {
  const libraries = [{ id: '1', name: 'Music', type: 'artist' }, { id: '2', name: 'Films', type: 'movie' }];
  assert.deepEqual(videoCategories(libraries, false).map(({ key }) => key), ['videoHome', 'library:2']);
  assert.deepEqual(videoCategories(libraries, true).map(({ key }) => key), ['videoHome', 'library:2', 'videoWatchlist']);
});

const episodes = [
  { id: 'one', type: 'episode', title: 'Pilot', viewCount: 1 },
  { id: 'two', type: 'episode', title: 'Part Two', viewOffset: 60_000, duration: 2_400_000 },
  { id: 'three', type: 'episode', title: 'Part Three' },
];

test('episode playback resumes at the saved episode and Play Next preserves queue order', () => {
  assert.equal(resumeEpisode(episodes), episodes[1]);
  assert.equal(collectionResumes(episodes), true);
  assert.deepEqual(queueFromEpisode(episodes, 'two'), episodes.slice(1));
  assert.deepEqual(insertNextEpisode(episodes, 'one', episodes[2]).map(({ id }) => id), ['one', 'three', 'two']);
  assert.deepEqual(episodes.map(({ id }) => id), ['one', 'two', 'three']);
});

test('episode labels use Plex titles and omit filename titles', () => {
  const episode = { type: 'episode', index: 3, parentIndex: 1 };
  assert.equal(episodeLabel({ ...episode, title: 'Part Three' }), 'S1:E3 · Part Three');
  assert.equal(episodeLabel({ ...episode, title: 'Series.S01E03.1080p.mkv' }), 'S1:E3');
});

test('the in-game overlay only moves when Quick Access would cover it', () => {
  const centered = getPipBounds(1280, 800, 25, 'center');
  assert.deepEqual(getPipBounds(1280, 800, 25, 'center', 940), centered);
  const moved = getPipBounds(1280, 800, 25, 'bottom-right', 940);
  assert.equal(moved.x + moved.width, 940);
  assert.equal(moved.width, centered.width);
});
