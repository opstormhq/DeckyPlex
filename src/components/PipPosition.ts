export const pipPositions = [
  { id: 'top-left', label: 'Top left' },
  { id: 'top-center', label: 'Top center' },
  { id: 'top-right', label: 'Top right' },
  { id: 'center-left', label: 'Center left' },
  { id: 'center', label: 'Center' },
  { id: 'center-right', label: 'Center right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'bottom-center', label: 'Bottom center' },
  { id: 'bottom-right', label: 'Bottom right' },
] as const;

export type PipPosition = typeof pipPositions[number]['id'];
export const defaultPipPosition: PipPosition = 'bottom-left';
export const defaultPipSize = 30;

export function getPipBounds(width: number, height: number, sizePercent: number, position: PipPosition, trayLeft = width) {
  const margin = Math.round(Math.min(width * 0.018, height * 0.05));
  const size = Math.round(Math.min(width * sizePercent / 100, height * 0.96, trayLeft - margin));
  const videoHeight = Math.round(size * 9 / 16);
  const centeredX = Math.round((width - size) / 2);
  const preferredX = position.endsWith('left') ? margin
    : position.endsWith('right') ? width - size - margin : centeredX;
  const x = Math.min(preferredX, trayLeft - size);
  const y = position.startsWith('top') ? margin
    : position.startsWith('bottom') ? height - videoHeight - margin
    : Math.round((height - videoHeight) / 2);
  return { x, y, width: size, height: videoHeight };
}
