import { ModalRoot, showModal } from '@decky/ui';
import { FaPlay, FaStepBackward } from 'react-icons/fa';
import { ChoiceDialogBody, ChoiceDialogList, ChoiceDialogRow } from './ChoiceDialog';

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
    <PlaybackStartDialog {...options} actionTitle={actionTitle} onChoose={finish} onCancel={() => finish()} />,
    window, { strTitle: actionTitle, bNeverPopOut: true, fnOnClose: closedExternally },
  );
  void dialog.ClosedPromise?.then(closedExternally, closedExternally);
  return { Close: () => finish() };
}

function PlaybackStartDialog({ title, actionTitle, position, resumeLabel, firstLabel, onChoose, onCancel }: {
  title: string;
  actionTitle: string;
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
  return (
    <ModalRoot closeModal={onCancel} onCancel={onCancel} onOK={() => {}}>
      <ChoiceDialogBody title={actionTitle} subtitle={title}>
        <ChoiceDialogList>
          <ChoiceDialogRow title="Resume" detail={resumeDetail} icon={<FaPlay />} preferredFocus onChoose={() => onChoose('resume')} />
          <ChoiceDialogRow title="Start from beginning" detail={firstLabel} icon={<FaStepBackward />} onChoose={() => onChoose('beginning')} />
        </ChoiceDialogList>
      </ChoiceDialogBody>
    </ModalRoot>
  );
}
