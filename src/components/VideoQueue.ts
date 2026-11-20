import type { VideoItem } from './GamePip';

export function episodeLabel(item: Pick<VideoItem, 'type' | 'title' | 'index' | 'parentIndex'>) {
  if (item.type !== 'episode') return item.title;
  const title = (item.title || '').trim();
  const episode = /^[0-9]+$/.test(String(item.index)) ? `E${item.index}` : '';
  const season = /^[0-9]+$/.test(String(item.parentIndex)) ? `S${item.parentIndex}` : '';
  const numbering = [season, episode].filter(Boolean).join(':');
  const looksLikeFilename = /\.(?:mkv|mp4|avi|mov|m4v|ts|webm|wmv|mpg|mpeg)$/i.test(title)
    || /(?:\bs\d{1,3}[:. _-]*e\d{1,4}\b|\b\d{1,2}x\d{1,4}\b)/i.test(title)
    || /^(?:episode\s+)?\d+$/i.test(title)
    || /(?:^|[ ._\-])(?:1080p|2160p|720p|x264|x265|web[._ -]?(?:dl|rip)|bluray)(?:[ ._\-]|$)/i.test(title);
  return [numbering, looksLikeFilename ? '' : title].filter(Boolean).join(' · ') || 'Episode';
}

export function queueFromEpisode(episodes: VideoItem[], id: string) {
  const index = episodes.findIndex(episode => episode.id === id);
  return index < 0 ? [] : episodes.slice(index);
}

export function resumeEpisode(episodes: VideoItem[]) {
  return episodes.find(episode => !(episode.viewCount || 0) && (episode.viewOffset || 0) > 0)
    ?? episodes.find(episode => !(episode.viewCount || 0))
    ?? episodes[0];
}

export function resumePosition(offsetMs: number, durationMs: number) {
  const seconds = offsetMs / 1000;
  return seconds >= 30 && (!durationMs || seconds < durationMs / 1000 - 15) ? seconds : 0;
}

export function collectionResumes(episodes: VideoItem[]) {
  const start = resumeEpisode(episodes);
  return !!start && (start.id !== episodes[0]?.id || resumePosition(start.viewOffset || 0, start.duration || 0) > 0);
}

export function insertNextEpisode(episodes: VideoItem[], currentId: string, episode: VideoItem) {
  if (currentId === episode.id) return episodes;
  const remaining = episodes.filter(entry => entry.id !== episode.id);
  const index = remaining.findIndex(entry => entry.id === currentId);
  if (index < 0) return episodes;
  return [...remaining.slice(0, index + 1), episode, ...remaining.slice(index + 1)];
}

export function videoSeekStep(duration: number) {
  return Math.max(5, Math.round(duration / 120));
}
