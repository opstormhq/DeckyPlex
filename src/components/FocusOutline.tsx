import { focusRingClasses } from '@decky/ui';

export const focusOutlineProps = {
  noFocusRing: true,
  className: 'deckyplex-focus-outline',
  focusClassName: 'deckyplex-focus-outline-active',
};

export function FocusOutlineStyles() {
  return <style>{`
    .deckyplex-focus-outline {
      position: relative;
    }
    .deckyplex-focus-outline-active::after {
      content: '';
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
      border-radius: 4px;
      outline: 2px solid rgba(255, 255, 255, 0.6);
      outline-offset: -2px;
      animation: ${focusRingClasses?.flash || 'none'} .5s ease, ${focusRingClasses?.blinker || 'none'} 1.2s ease-in-out .4s 20;
    }
  `}</style>;
}
