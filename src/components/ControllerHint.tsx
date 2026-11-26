export function ControllerHint({ button, children }: { button: string; children: string }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', whiteSpace: 'nowrap', fontSize: '0.75rem' }}>
    <kbd style={{ display: 'grid', placeItems: 'center', width: '1rem', height: '1rem', boxSizing: 'border-box',
      border: '1px solid currentColor', borderRadius: '50%', font: 'inherit', lineHeight: 1 }}>{button}</kbd>
    {children}
  </span>;
}
