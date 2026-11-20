import { Button, DialogLabel, Focusable, ModalRoot, PanelSection, PanelSectionRow, showModal } from '@decky/ui';

type PlaybackStart = 'resume' | 'beginning';

interface PlaybackStartOptions {
  title: string;
  actionTitle: string;
  position: number;
  resumeLabel?: string;
  firstLabel?: string;
  onClose: (choice?: PlaybackStart) => void;
}

export function showPlaybackStartDialog({ actionTitle, onClose, ...options }: PlaybackStartOptions) {
  let closed = false;
  const finish = (choice?: PlaybackStart) => {
    if (closed) return;
    closed = true;
    dialog.Close();
    onClose(choice);
  };
  const closedExternally = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  const dialog = showModal(
    <PlaybackStartDialog {...options} onChoose={finish} onCancel={() => finish()} />,
    window, { strTitle: actionTitle, bNeverPopOut: true, fnOnClose: closedExternally },
  );
  void dialog.ClosedPromise?.then(closedExternally, closedExternally);
  return { Close: () => finish() };
}

function PlaybackStartDialog({ title, position, resumeLabel, firstLabel, onChoose, onCancel }: {
  title: string;
  position: number;
  resumeLabel?: string;
  firstLabel?: string;
  onChoose: (start: PlaybackStart) => void;
  onCancel: () => void;
}) {
  const hours = Math.floor(position / 3600);
  const minutes = Math.floor(position / 60) % 60;
  const seconds = String(Math.floor(position % 60)).padStart(2, '0');
  const resumeTime = hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
  const resumeDetail = [resumeLabel, position > 0 ? `${resumeTime} in` : null].filter(Boolean).join(' · ');
  const detailStyle = { fontSize: '0.82rem', opacity: 0.75, overflowWrap: 'anywhere' as const };
  return (
    <ModalRoot closeModal={onCancel} onCancel={onCancel}>
      <PanelSection>
        <PanelSectionRow><DialogLabel style={{ margin: 0 }}>{title}</DialogLabel></PanelSectionRow>
        <PanelSectionRow>
          <Focusable flow-children="column" style={{ width: '100%', display: 'grid', gap: '0.45rem' }}>
            <Button preferredFocus onClick={() => onChoose('resume')} style={{ width: '100%', textAlign: 'left' }}>
              <span style={{ display: 'grid', gap: '0.2rem' }}>
                <span>Resume</span>
                {resumeDetail && <span style={detailStyle}>{resumeDetail}</span>}
              </span>
            </Button>
            <Button onClick={() => onChoose('beginning')} style={{ width: '100%', textAlign: 'left' }}>
              <span style={{ display: 'grid', gap: '0.2rem' }}>
                <span>Start from beginning</span>
                {firstLabel && <span style={detailStyle}>{firstLabel}</span>}
              </span>
            </Button>
          </Focusable>
        </PanelSectionRow>
      </PanelSection>
    </ModalRoot>
  );
}
