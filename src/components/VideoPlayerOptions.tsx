import { useLayoutEffect, useRef, useState } from 'react';
import { DialogBodyText, Focusable } from '@decky/ui';
import { FaCheck, FaClosedCaptioning, FaCog, FaFilm, FaInfoCircle, FaListOl, FaVolumeUp } from 'react-icons/fa';
import { ChoiceDialogBody, ChoiceDialogList, ChoiceDialogRow } from './ChoiceDialog';
import { InlineSpinner } from './InlineSpinner';
import { formatVideoTime } from './VideoScrubber';
import { PlaybackSlider } from './PlaybackSlider';

export type VideoOptionPage = 'main' | 'quality' | 'audio' | 'subtitles' | 'captionSize' | 'captionTiming' | 'versions' | 'chapters' | 'info';
export type VideoOption<T = number> = { data: T; label: string };
export type VideoChapter = { title: string; start: number };
export type VideoMarker = { type: 'intro' | 'credits'; start: number; end: number };
export type VideoPlaybackPreferences = {
  video_caption_size: number;
  video_caption_auto_sync: boolean;
  video_boost_dialog: boolean;
  video_normalize_loudness: boolean;
};
export type VideoPlaybackOption = keyof VideoPlaybackPreferences;

const captionMin = 75;
const captionMax = 225;
const captionStep = 5;

function CaptionSizeSlider({ value, busy, apply }: { value: number; busy: boolean; apply: (size: number) => void }) {
  const [size, setSize] = useState(value);
  return <PlaybackSlider label="Caption scale" value={size} min={captionMin} max={captionMax} step={captionStep}
    disabled={busy} onChange={setSize} confirmLabel="Apply caption size" onConfirm={() => {
      if (size !== value) apply(size);
    }} />;
}

type OptionGroups = {
  quality: { options: VideoOption<string>[]; selected: string; choose: (value: string) => void };
  audio: { options: VideoOption[]; selected?: number; choose: (value: number) => void };
  subtitles: { options: VideoOption[]; selected?: number; choose: (value: number) => void };
  versions: { options: VideoOption[]; selected?: number; choose: (value: number) => void };
};

const groups = [
  { key: 'quality', title: 'Stream quality', Icon: FaCog },
  { key: 'audio', title: 'Audio', Icon: FaVolumeUp },
  { key: 'subtitles', title: 'Captions', Icon: FaClosedCaptioning },
  { key: 'versions', title: 'Play version', Icon: FaFilm },
] as const;

export function VideoPlayerOptions({ page, onPage, choices, chapters, seek, info, busy, error, tuning }: {
  page: VideoOptionPage;
  onPage: (page: VideoOptionPage) => void;
  choices: OptionGroups;
  chapters: VideoChapter[];
  seek: (position: number) => void;
  info: string[];
  busy: boolean;
  error: string;
  tuning: {
    preferences?: VideoPlaybackPreferences;
    captionSize?: boolean;
    captionAutoSync?: boolean;
    captionOffset?: number | null;
    boostDialog?: boolean;
    normalizeLoudness?: boolean;
    change: <K extends VideoPlaybackOption>(key: K, value: VideoPlaybackPreferences[K]) => void;
    changeOffset: (offset: number) => void;
  };
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const infoRef = useRef<HTMLDivElement>(null);
  const previousPage = useRef<VideoOptionPage | undefined>(undefined);
  const optionsRef = useRef<Partial<Record<VideoOptionPage, HTMLDivElement | null>>>({});
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const lastPage = previousPage.current;
    previousPage.current = page;
    if (lastPage === page && panel?.contains(panel.ownerDocument.activeElement)
        && panel.ownerDocument.activeElement?.getAttribute('aria-disabled') !== 'true') return;
    const returning = lastPage && (page === 'main' || page === 'subtitles') ? optionsRef.current[lastPage] : null;
    const enabled = ':is([role="button"], [role="slider"]):not([aria-disabled="true"])';
    const target = (returning?.matches(enabled) ? returning : null)
      ?? panel?.querySelector<HTMLElement>(`${enabled}[aria-pressed="true"]`)
      ?? panel?.querySelector<HTMLElement>(enabled)
      ?? infoRef.current
      ?? panel;
    target?.focus({ preventScroll: true });
  }, [page, busy]);

  const group = groups.find(group => group.key === page);
  const pageTitles = { main: 'Playback settings', captionSize: 'Caption size', captionTiming: 'Subtitle timing',
    chapters: 'Chapters', info: 'Playback info' };
  const title = group?.title ?? pageTitles[page as keyof typeof pageTitles];
  const prefs = tuning.preferences;
  const captionOffset = tuning.captionOffset;
  const formatOffset = (value: number) => value === 0 ? 'No offset' : `${Math.abs(value)} ms ${value > 0 ? 'later' : 'earlier'}`;
  return (
    <Focusable ref={panelRef} tabIndex={-1} flow-children="column" className="deckyplex-video-glass"
      style={{ position: 'absolute', zIndex: 3, right: '1rem', bottom: '1rem', padding: '0.85rem' }}>
      <ChoiceDialogBody title={title}>
        <ChoiceDialogList>
          {page === 'main' && <>
            {groups.filter(({ key }) => choices[key].options.length > 1
              || key === 'subtitles' && choices[key].options.length > 0
              || key === 'audio' && (tuning.boostDialog || tuning.normalizeLoudness))
              .map(({ key, title, Icon }) => <ChoiceDialogRow key={key} title={title}
                rowRef={element => { optionsRef.current[key] = element; }}
                detail={choices[key].options.find(option => option.data === choices[key].selected)?.label}
                icon={<Icon />} disabled={busy} onChoose={() => onPage(key)} />)}
            {chapters.length > 0 && <ChoiceDialogRow title="Chapters" icon={<FaListOl />} disabled={busy}
              rowRef={element => { optionsRef.current.chapters = element; }} onChoose={() => onPage('chapters')} />}
            <ChoiceDialogRow title="Playback info" icon={<FaInfoCircle />}
              rowRef={element => { optionsRef.current.info = element; }} onChoose={() => onPage('info')} />
          </>}
          {group && choices[group.key].options.map(option => {
            const selected = choices[group.key].selected === option.data;
            return <ChoiceDialogRow key={option.data} title={option.label}
              icon={selected ? <FaCheck /> : <group.Icon />} selected={selected} disabled={busy}
              onChoose={() => {
                if (selected) return;
                if (group.key === 'quality') choices.quality.choose(String(option.data));
                else choices[group.key].choose(Number(option.data));
              }} />;
          })}
          {page === 'audio' && prefs && <>
            {tuning.boostDialog && <ChoiceDialogRow title="Boost dialogue" detail="Requires Plex Pass"
              icon={<FaVolumeUp />} disabled={busy} selected={prefs.video_boost_dialog}
              onChoose={() => tuning.change('video_boost_dialog', !prefs.video_boost_dialog)} />}
            {tuning.normalizeLoudness && <ChoiceDialogRow title="Normalize loudness" detail="Requires Plex Pass"
              icon={<FaVolumeUp />} disabled={busy} selected={prefs.video_normalize_loudness}
              onChoose={() => tuning.change('video_normalize_loudness', !prefs.video_normalize_loudness)} />}
          </>}
          {page === 'subtitles' && prefs && <>
            {tuning.captionSize && <ChoiceDialogRow title="Caption size" icon={<FaClosedCaptioning />}
              detail={`${prefs.video_caption_size}%`} disabled={busy}
              rowRef={element => { optionsRef.current.captionSize = element; }} onChoose={() => onPage('captionSize')} />}
            {captionOffset != null && <ChoiceDialogRow title="Subtitle timing" icon={<FaClosedCaptioning />}
              detail={formatOffset(captionOffset)} disabled={busy}
              rowRef={element => { optionsRef.current.captionTiming = element; }} onChoose={() => onPage('captionTiming')} />}
            {tuning.captionAutoSync && <ChoiceDialogRow title="Automatically sync subtitles" detail="Requires Plex Pass"
              icon={<FaClosedCaptioning />} disabled={busy} selected={prefs.video_caption_auto_sync}
              onChoose={() => tuning.change('video_caption_auto_sync', !prefs.video_caption_auto_sync)} />}
          </>}
          {page === 'captionSize' && prefs && <CaptionSizeSlider key={prefs.video_caption_size}
            value={prefs.video_caption_size} busy={busy} apply={size => tuning.change('video_caption_size', size)} />}
          {page === 'captionTiming' && captionOffset != null && <>
            {[-500, -100, 100, 500].map(delta => <ChoiceDialogRow key={delta}
              title={`Move ${formatOffset(delta)}`} icon={<FaClosedCaptioning />}
              detail={formatOffset(captionOffset + delta)} disabled={busy || Math.abs(captionOffset + delta) > 30000}
              onChoose={() => tuning.changeOffset(captionOffset + delta)} />)}
            <ChoiceDialogRow title="Reset subtitle timing" detail={formatOffset(captionOffset)} icon={<FaClosedCaptioning />}
              disabled={busy || captionOffset === 0} onChoose={() => tuning.changeOffset(0)} />
          </>}
          {page === 'chapters' && chapters.map((chapter, index) =>
            <ChoiceDialogRow key={`${chapter.start}:${index}`} title={chapter.title || `Chapter ${index + 1}`}
              detail={formatVideoTime(chapter.start)} icon={<FaListOl />} onChoose={() => seek(chapter.start)} />,
          )}
          {page === 'info' && <Focusable ref={infoRef} tabIndex={0} aria-label="Playback info" {...{ focusable: true }}>
            {info.map(text => <DialogBodyText key={text} style={{ margin: '0.25rem 0' }}>{text}</DialogBodyText>)}
          </Focusable>}
        </ChoiceDialogList>
        {(busy || error) && <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: '0.4rem' }}>
          {busy && <InlineSpinner />}
          <DialogBodyText style={{ margin: 0 }}>{busy ? 'Updating playback…' : error}</DialogBodyText>
        </div>}
      </ChoiceDialogBody>
    </Focusable>
  );
}
