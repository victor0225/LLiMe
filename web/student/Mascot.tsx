import { useLayoutEffect, useRef } from 'react';
import mascotMarkup from '../assets/mascot/mascot.svg?raw';
import '../assets/mascot/mascot.css';

// Poses of the llime companion. A pose is presentation only and never stands for learning state.
export type MascotState = 'idle' | 'welcome' | 'listening' | 'thinking' | 'encouragement';

export type MascotProps = {
  readonly state: MascotState;
  // Rendered width in CSS pixels; the artwork keeps its own aspect ratio.
  readonly size?: number;
  // Off keeps the static pose. The system reduced-motion setting turns motion off as well.
  readonly motion?: boolean;
};

const DEFAULT_SIZE_PX = 170;

// The SVG is inlined so its parts can animate; an <img> would hide them from the stylesheet. It is
// decorative: the tutor copy next to it carries the meaning.
export function Mascot({ state, size = DEFAULT_SIZE_PX, motion = true }: MascotProps) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const svg = host.current?.querySelector('svg');
    if (!svg) return;
    svg.removeAttribute('role');
    svg.removeAttribute('aria-label');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.dataset.state = state;
    svg.dataset.motion = motion ? 'on' : 'off';
  }, [state, motion]);
  return <div ref={host} className="student-mascot" style={{ width: size }} dangerouslySetInnerHTML={{ __html: mascotMarkup }} />;
}
