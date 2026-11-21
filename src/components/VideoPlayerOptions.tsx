import { useLayoutEffect, useRef } from 'react';
import { DialogBodyText, Focusable } from '@decky/ui';
import { FaCheck, FaClosedCaptioning, FaCog, FaFilm, FaInfoCircle, FaListOl, FaVolumeUp } from 'react-icons/fa';
import { ChoiceDialogBody, ChoiceDialogList, ChoiceDialogRow } from './ChoiceDialog';
import { InlineSpinner } from './InlineSpinner';
import { formatVideoTime } from './VideoScrubber';

export type VideoOptionPage = 'main' | 'quality' | 'audio' | 'subtitles' | 'versions' | 'chapters' | 'info';
export type VideoOption<T = number> = { data: T; label: string };
export type VideoChapter = { title: string; start: number };
export type VideoMarker = { type: 'intro' | 'credits'; start: number; end: number };

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

export function VideoPlayerOptions({ page, onPage, choices, chapters, seek, info, busy, error }: {
  page: VideoOptionPage;
  onPage: (page: VideoOptionPage) => void;
  choices: OptionGroups;
  chapters: VideoChapter[];
  seek: (position: number) => void;
  info: string[];
  busy: boolean;
  error: string;
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
    const returning = page === 'main' && lastPage !== undefined ? optionsRef.current[lastPage] : null;
    const enabled = '[role="button"]:not([aria-disabled="true"])';
    const target = (returning?.matches(enabled) ? returning : null)
      ?? panel?.querySelector<HTMLElement>(`${enabled}[aria-pressed="true"]`)
      ?? panel?.querySelector<HTMLElement>(enabled)
      ?? infoRef.current
      ?? panel;
    target?.focus({ preventScroll: true });
  }, [page, busy]);

  const group = groups.find(group => group.key === page);
  const title = group?.title ?? (page === 'chapters' ? 'Chapters' : page === 'info' ? 'Playback info' : 'Playback settings');
  return (
    <Focusable ref={panelRef} tabIndex={-1} flow-children="column" style={{ position: 'absolute', zIndex: 3, right: '1rem', bottom: '1rem',
      padding: '0.85rem', background: '#16212e', borderRadius: 8, boxShadow: '0 5px 24px #000a' }}>
      <ChoiceDialogBody title={title}>
        <ChoiceDialogList>
          {page === 'main' && <>
            {groups.filter(({ key }) => choices[key].options.length > 1 || key === 'subtitles' && choices[key].options.length > 0)
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
