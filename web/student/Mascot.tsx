import { useLayoutEffect, useRef } from 'react';
import mascotMarkup from '../assets/mascot/mascot.svg?raw';
import '../assets/mascot/mascot.css';
import welcomeUrl from '../assets/characters/llime-welcome.png?no-inline';
import listeningUrl from '../assets/characters/llime-listening.png?no-inline';
import encouragementUrl from '../assets/characters/llime-encouragement.png?no-inline';

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

// Full character art for the moments that have a painted pose: welcome on the invitation, listening
// while the child explains, encouragement on the outcome. The artwork carries transparent margins, so
// it is shown square and uncropped.
const CHARACTER_ART: Partial<Record<MascotState, string>> = {
  welcome: welcomeUrl,
  listening: listeningUrl,
  encouragement: encouragementUrl,
};

// Decorative either way: the tutor copy next to it carries the meaning.
export function Mascot({ state, size = DEFAULT_SIZE_PX, motion = true }: MascotProps) {
  const art = CHARACTER_ART[state];
  if (art) return <CharacterArt src={art} state={state} size={size} motion={motion} />;
  return <VectorMascot state={state} size={size} motion={motion} />;
}

function CharacterArt({ src, state, size, motion }: { src: string; state: MascotState; size: number; motion: boolean }) {
  return (
    <img
      className="student-mascot student-character"
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      data-state={state}
      data-motion={motion ? 'on' : 'off'}
      draggable={false}
    />
  );
}

// The SVG is inlined so its parts can animate; an <img> would hide them from the stylesheet.
function VectorMascot({ state, size, motion }: { state: MascotState; size: number; motion: boolean }) {
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
