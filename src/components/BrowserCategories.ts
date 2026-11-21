export const musicCategories = [
  { key: 'artists', title: 'Artists' },
  { key: 'albums', title: 'Albums' },
  { key: 'tracks', title: 'Songs' },
  { key: 'recent', title: 'Recently Played' },
  { key: 'recentlyAdded', title: 'Recently Added' },
  { key: 'playlists', title: 'Playlists' },
] as const;

export type LibraryTab = `library:${string}`;
export type MusicTab = typeof musicCategories[number]['key'];
export type VideoTab = 'videoHome' | 'videoWatchlist' | LibraryTab;
export type CategoryLayout = { order: string[]; hidden: string[] };
export type BrowserLayouts = Record<string, CategoryLayout>;

export function videoCategories(libraries: { id: string; name: string; type: string }[]) {
  const categories: { key: VideoTab; title: string; type: string }[] = [];
  const hasVideos = libraries.some(library => library.type === 'movie' || library.type === 'show');
  if (hasVideos) {
    categories.push({ key: 'videoHome', title: 'Home', type: 'home' });
  }
  for (const library of libraries) {
    if (library.type !== 'artist') {
      categories.push({ key: `library:${library.id}`, title: library.name, type: library.type });
    }
  }
  if (hasVideos) categories.push({ key: 'videoWatchlist', title: 'Watchlist', type: 'watchlist' });
  return categories;
}

export function orderCategories<T extends { key: string }>(categories: readonly T[], layout?: CategoryLayout): T[] {
  const entries = new Map(categories.map(category => [category.key, category]));
  const ordered: T[] = [];
  for (const key of layout?.order ?? []) {
    const category = entries.get(key);
    if (!category) continue;
    ordered.push(category);
    entries.delete(key);
  }
  return [...ordered, ...entries.values()];
}

export function visibleCategories<T extends { key: string }>(categories: readonly T[], layout?: CategoryLayout): T[] {
  const hidden = new Set(layout?.hidden);
  return orderCategories(categories, layout).filter(category => !hidden.has(category.key));
}
