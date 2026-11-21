import { Button, DialogHeader, Focusable, ModalRoot } from '@decky/ui';
import { pipPositions, type PipPosition } from './PipPosition';

export function PipPositionDialog({ selected, choose, close }: {
  selected: PipPosition;
  choose: (position: PipPosition) => void;
  close: () => void;
}) {
  return (
    <ModalRoot closeModal={close} onCancel={close} onOK={() => {}}>
      <div style={{ width: 'min(17rem, 68vw, 56vh)', marginInline: 'auto' }}>
        <DialogHeader style={{ margin: '0 0 0.65rem', textAlign: 'center', fontSize: '1.05rem', lineHeight: 1.25 }}>
          Picture-in-picture position
        </DialogHeader>
        <style>{`
          .deckyplex-pip-position-grid button.deckyplex-pip-position-cell {
            padding: 0 !important;
            margin: 0 !important;
            border: 0 !important;
            border-radius: 0 !important;
            background: #10151c !important;
            box-shadow: none !important;
            color: #778496 !important;
          }
          .deckyplex-pip-position-grid button.deckyplex-pip-position-cell[aria-pressed="true"] {
            background: #162535 !important;
            color: #80c6ff !important;
          }
          .deckyplex-pip-position-grid button.deckyplex-pip-position-cell:is(.gpfocus, :focus-visible) {
            background: #26384a !important;
            color: #f0f6ff !important;
            outline: 2px solid #a8d3f8 !important;
            outline-offset: -2px;
          }
          .deckyplex-pip-position-grid button.deckyplex-pip-position-cell:hover:not(.gpfocus) {
            background: #202d3c !important;
          }
        `}</style>
        <Focusable flow-children="geometric" role="group" aria-label="Position on screen"
          className="deckyplex-pip-position-grid"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gridTemplateRows: 'repeat(3, minmax(0, 1fr))',
            width: '100%', aspectRatio: '16 / 10', boxSizing: 'border-box', gap: 1, overflow: 'hidden',
            border: '1px solid #344152', borderRadius: '0.45rem', background: '#2b3644' }}>
          {pipPositions.map(({ id, label }) => {
            const active = selected === id;
            return <Button key={id} className="deckyplex-pip-position-cell" noFocusRing
              preferredFocus={active} aria-label={label} aria-pressed={active}
              onOKActionDescription={label} onClick={() => choose(id)}
              style={{ display: 'grid', placeItems: 'center', minWidth: 0, minHeight: 0 }}>
              <span aria-hidden="true" style={{ width: '1.35rem', maxWidth: '55%', aspectRatio: '16 / 9',
                boxSizing: 'border-box', borderRadius: '0.17rem', border: '1px solid currentColor',
                background: active ? 'currentColor' : 'transparent' }} />
            </Button>;
          })}
        </Focusable>
      </div>
    </ModalRoot>
  );
}
