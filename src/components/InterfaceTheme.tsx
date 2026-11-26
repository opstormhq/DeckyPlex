import { gamepadContextMenuClasses, gamepadDialogClasses, ModalRoot, type ModalRootProps } from '@decky/ui';

export function InterfaceThemeStyles() {
  return <style>{`
    :is([data-deckyplex-light], .deckyplex-light-menu) {
      color-scheme: light;
      --deckyplex-bg: #edf2f8;
      --deckyplex-surface: #f9fbff;
      --deckyplex-text: #182b40;
      --deckyplex-muted: #405873;
      --deckyplex-border: #a8bbd0;
      --deckyplex-button: #dce7f4;
      --deckyplex-primary: #c7d9ee;
      --deckyplex-hover: #c2d7ee;
      --deckyplex-focus: #17559a;
      --deckyplex-focus-text: #0e243d;
      --deckyplex-accent: #245b95;
      --deckyplex-error: #9d292a;
      --deckyplex-disabled: #607489;
    }
    [data-deckyplex-light]:not([data-deckyplex-quick-player]) :is(.DialogLabel, .DialogBodyText, .DialogHeader) {
      color: var(--deckyplex-text);
      text-shadow: none;
    }
    [data-deckyplex-light] :is(input:not([type="range"]), textarea) {
      background: var(--deckyplex-surface);
      color: var(--deckyplex-text);
      caret-color: currentColor;
    }
    [data-deckyplex-light] :is(input, textarea)::placeholder { color: var(--deckyplex-muted); }
    [data-deckyplex-light] ::selection { color: var(--deckyplex-focus-text); background: var(--deckyplex-hover); }
    [data-deckyplex-light] :is(
      button, [role="button"], [role="tab"], [role="switch"], [role="combobox"],
      [data-browser-tab], [data-browser-item-id], [data-browser-play-collection]
    ):is(.gpfocus, :focus-visible, .deckyplex-focus-outline-active, [aria-selected="true"]) {
      color: var(--deckyplex-focus-text) !important;
      text-shadow: none !important;
    }
    [data-deckyplex-light] :is([role="button"], [role="tab"], button):is(
      .gpfocus, :focus-visible, .deckyplex-focus-outline-active, [aria-selected="true"]
    ) :is(.DialogLabel, .DialogBodyText, .DialogHeader, [data-deckyplex-choice-text]) {
      color: inherit !important;
    }
    .deckyplex-light-modal, .DialogContent:has([data-deckyplex-modal]) {
      color: #182b40 !important;
      background: #edf2f8 !important;
    }
    [data-deckyplex-modal] {
      color: var(--deckyplex-text);
      background: var(--deckyplex-bg);
      border-radius: 0.7rem;
    }
    [data-deckyplex-modal] button:not(.deckyplex-pip-position-cell) {
      background: var(--deckyplex-button) !important;
      color: var(--deckyplex-text) !important;
      border-color: var(--deckyplex-border) !important;
      text-shadow: none !important;
    }
    [data-deckyplex-modal] :is(button, [role="button"], [role="slider"]):is(
      .gpfocus, :focus-visible, .deckyplex-focus-outline-active
    ):not(:disabled, [aria-disabled="true"]) {
      background: var(--deckyplex-hover) !important;
      color: var(--deckyplex-focus-text) !important;
      outline-color: var(--deckyplex-focus) !important;
    }
    [data-deckyplex-modal] [data-deckyplex-choice-row][aria-disabled="true"] {
      color: var(--deckyplex-muted);
      opacity: 1 !important;
    }
    [data-deckyplex-modal] :is(.${gamepadDialogClasses?.Field || 'deckyplex-no-match'},
      .${gamepadDialogClasses?.FieldClickTarget || 'deckyplex-no-match'}) {
      background: transparent !important; color: var(--deckyplex-text) !important;
    }
    [data-deckyplex-modal] :is(.${gamepadDialogClasses?.FieldLabel || 'deckyplex-no-match'},
      .${gamepadDialogClasses?.FieldDescription || 'deckyplex-no-match'}) {
      color: var(--deckyplex-text) !important;
    }
    [data-deckyplex-modal] .${gamepadDialogClasses?.ToggleRail || 'deckyplex-no-match'} {
      background: var(--deckyplex-disabled) !important;
    }
    [data-deckyplex-modal] [aria-checked="true"] .${gamepadDialogClasses?.ToggleRail || 'deckyplex-no-match'},
    [data-deckyplex-modal] .${gamepadDialogClasses?.On || 'deckyplex-no-match'} .${gamepadDialogClasses?.ToggleRail || 'deckyplex-no-match'} {
      background: var(--deckyplex-accent) !important;
    }
    [data-deckyplex-modal] .${gamepadDialogClasses?.ToggleSwitch || 'deckyplex-no-match'} {
      background: var(--deckyplex-surface) !important;
    }
    .deckyplex-light-menu,
    .deckyplex-light-menu .${gamepadContextMenuClasses?.contextMenuContents || 'deckyplex-no-match'} {
      background: var(--deckyplex-bg) !important; color: var(--deckyplex-text) !important;
    }
    .deckyplex-light-menu .${gamepadContextMenuClasses?.contextMenuItem || 'deckyplex-no-match'} {
      color: var(--deckyplex-text) !important; text-shadow: none !important;
    }
    .deckyplex-light-menu .${gamepadContextMenuClasses?.contextMenuItem || 'deckyplex-no-match'}:is(
      .gpfocus, :focus-visible, .${gamepadContextMenuClasses?.Focused || 'deckyplex-no-match'},
      .${gamepadContextMenuClasses?.Selected || 'deckyplex-no-match'}
    ) {
      background: var(--deckyplex-hover) !important; color: var(--deckyplex-focus-text) !important;
    }
  `}</style>;
}

export function DeckyPlexModal({ lightTheme, className, children, ...props }: ModalRootProps & { lightTheme?: boolean }) {
  const classes = ['deckyplex-modal', lightTheme && 'deckyplex-light-modal', className].filter(Boolean).join(' ');
  if (!lightTheme) return <ModalRoot {...props} className={classes}>{children}</ModalRoot>;
  return <ModalRoot {...props} className={classes}>
    <div data-deckyplex-modal="" data-deckyplex-light="">
      <InterfaceThemeStyles />
      {children}
    </div>
  </ModalRoot>;
}
