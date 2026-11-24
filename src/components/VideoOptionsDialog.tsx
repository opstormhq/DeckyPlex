import { useLayoutEffect, useRef, useState } from 'react';
import { Button, Focusable, GamepadButton, ModalRoot } from '@decky/ui';
import { FaBookmark, FaCheck, FaEyeSlash, FaRegStar, FaStar, FaStepBackward, FaStepForward, FaTimes } from 'react-icons/fa';
import { ChoiceDialogBody, ChoiceDialogList, ChoiceDialogRow } from './ChoiceDialog';
import { focusOutlineProps } from './FocusOutline';
import { episodeLabel, resumePosition } from './VideoQueue';
import type { VideoItem, VideoWatchState } from './GamePip';
import { selectWithSound } from './GamepadSounds';

export type VideoAction = 'mark_watched' | 'mark_unwatched' | 'remove_continue' | 'add_watchlist' | 'remove_watchlist' | 'rate';
export type VideoActionResult = VideoWatchState & { error?: string; on_watchlist?: boolean; user_rating?: number | null };

function RatingPicker({ userRating, save }: {
  userRating?: number | null;
  save: (rating: number | null) => void;
}) {
  const original = Math.max(0, Math.min(10, Math.round(userRating ?? 0)));
  const [rating, setRating] = useState(original);
  const sliderRef = useRef<HTMLDivElement>(null);
  const adjust = (step: number) => setRating(current => Math.max(0, Math.min(10, current + step)));
  const confirm = () => save(rating || null);
  const activate = (event: { preventDefault(): void; stopPropagation(): void }, repeat?: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    if (!repeat) selectWithSound(event, confirm);
  };
  const label = rating ? `${rating / 2} / 5 stars` : 'Unrated';

  return <>
    <Focusable {...focusOutlineProps} ref={sliderRef} role="slider" tabIndex={0} aria-label="Your rating"
      aria-valuemin={0} aria-valuemax={5} aria-valuenow={rating / 2} aria-valuetext={label} preferredFocus
      onGamepadDirection={event => {
        const button = event.detail.button;
        if (button !== GamepadButton.DIR_LEFT && button !== GamepadButton.DIR_RIGHT) return;
        event.preventDefault();
        event.stopPropagation();
        adjust(button === GamepadButton.DIR_RIGHT ? 1 : -1);
      }}
      onOKActionDescription="Save rating" onActivate={activate}
      onOKButton={event => activate(event, event.detail?.is_repeat)}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          event.stopPropagation();
          adjust(event.key === 'ArrowRight' ? 1 : -1);
        } else if (event.key === 'Enter' || event.key === ' ') {
          activate(event, event.repeat);
        }
      }}
      style={{ display: 'grid', justifyItems: 'center', gap: '0.55rem', padding: '0.8rem',
        borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)' }}>
      <div aria-hidden="true" style={{ display: 'flex', alignItems: 'center', fontSize: 'clamp(1.5rem, 5vw, 2.15rem)' }}>
        {Array.from({ length: 5 }, (_, index) => {
          const fill = Math.max(0, Math.min(2, rating - index * 2)) * 50;
          return <span key={index} onClick={event => {
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            setRating(index * 2 + (event.clientX < bounds.left + bounds.width / 2 ? 1 : 2));
            sliderRef.current?.focus();
          }} style={{ display: 'grid', padding: '0.2em', cursor: 'pointer' }}>
            <span style={{ display: 'grid', position: 'relative', color: '#9eabb9' }}>
              <FaRegStar />
              <FaStar style={{ position: 'absolute', inset: 0, color: '#ffc356',
                clipPath: `inset(0 ${100 - fill}% 0 0)`, pointerEvents: 'none' }} />
            </span>
          </span>;
        })}
      </div>
      <span aria-hidden="true" style={{ fontSize: '0.875rem', fontVariantNumeric: 'tabular-nums' }}>{label}</span>
    </Focusable>
    {userRating != null && <Button onClick={() => save(null)}>Clear rating</Button>}
  </>;
}

export function VideoOptionsDialog({ item, userRating, onWatchlist, allowAccountActions = true,
  canRemoveContinue, playFromBeginning, queueNext, apply, close }: {
  item: VideoItem;
  userRating?: number | null;
  onWatchlist?: boolean;
  allowAccountActions?: boolean;
  canRemoveContinue?: boolean;
  playFromBeginning: () => void;
  queueNext?: () => void;
  apply: (action: VideoAction, rating?: number | null) => void;
  close: () => void;
}) {
  const playable = item.type === 'movie' || item.type === 'episode';
  const supportsWatchlist = allowAccountActions && (item.type === 'movie' || item.type === 'show');
  const partial = resumePosition(item.viewOffset || 0, item.duration || 0) > 0;
  const [page, setPage] = useState<'options' | 'reset' | 'rating'>('options');
  const bodyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    (body?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? body?.querySelector<HTMLElement>('[tabindex="0"]'))?.focus();
  }, [page]);

  const cancel = () => {
    if (page === 'options') close();
    else setPage('options');
  };
  const title = { options: 'Video options', reset: 'Mark as unwatched?', rating: 'Your rating' }[page];

  return (
    <ModalRoot closeModal={cancel} onCancel={cancel} onOK={() => {}}>
      <ChoiceDialogBody title={title} subtitle={episodeLabel(item)} bodyRef={bodyRef}>
        <ChoiceDialogList>
          {page === 'reset' && <>
            <ChoiceDialogRow title="Keep progress" icon={<FaTimes />} preferredFocus onChoose={cancel} />
            <ChoiceDialogRow title="Mark as unwatched" icon={<FaEyeSlash />} destructive
              detail={item.type === 'episode' ? 'Clear the saved resume point for this episode.' : 'Clear the saved resume point for this movie.'}
              onChoose={() => apply('mark_unwatched')} />
          </>}
          {page === 'rating' && <RatingPicker userRating={userRating}
            save={rating => rating === (userRating ?? null) ? close() : apply('rate', rating)} />}
          {page === 'options' && <>
            {queueNext && <ChoiceDialogRow title="Play next" icon={<FaStepForward />} onChoose={queueNext} />}
            {partial && playable && <ChoiceDialogRow title="Play from beginning" icon={<FaStepBackward />} onChoose={playFromBeginning} />}
            {allowAccountActions && playable && canRemoveContinue && <ChoiceDialogRow title="Remove from Continue Watching" icon={<FaTimes />}
              onChoose={() => apply('remove_continue')} />}
            {allowAccountActions && playable && (!item.viewCount || !!item.viewOffset) && <ChoiceDialogRow title="Mark as watched" icon={<FaCheck />}
              onChoose={() => apply('mark_watched')} />}
            {allowAccountActions && playable && (!!item.viewCount || !!item.viewOffset) && <ChoiceDialogRow title="Mark as unwatched" icon={<FaEyeSlash />}
              onChoose={() => item.viewOffset ? setPage('reset') : apply('mark_unwatched')} />}
            {supportsWatchlist && <ChoiceDialogRow
              title={onWatchlist ? 'Remove from Watchlist' : 'Add to Watchlist'} icon={<FaBookmark />}
              onChoose={() => apply(onWatchlist ? 'remove_watchlist' : 'add_watchlist')} />}
            {allowAccountActions && <ChoiceDialogRow title="Your rating" detail={userRating == null ? undefined : `${userRating / 2} / 5 stars`}
              icon={<FaStar />} onChoose={() => setPage('rating')} />}
          </>}
        </ChoiceDialogList>
      </ChoiceDialogBody>
    </ModalRoot>
  );
}
