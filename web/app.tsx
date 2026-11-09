import { type ComponentType, lazy, Suspense } from 'react';
import { STUDENT_COPY } from '@core/copy';
import { LessonNotes } from './notes/LessonNotes';
import { StudentApp } from './student/StudentApp';

type Surface = ComponentType<{ runId: string | null }>;

// One entry per surface, keyed by URL path without a trailing slash (the iPad shell may add one). The
// backend surface loads only when its path is opened, so no page pays for another surface's code.
// Lanes add their own line here.
const SURFACES: Readonly<Record<string, Surface>> = {
  '/lesson-notes': LessonNotes,
  '/student': StudentApp,
  '/backend': lazy(() => import('./backend/LearningMemoryScene').then((module) => ({ default: module.BackendSurface }))),
};

function Waiting() {
  return (
    <main
      style={{
        boxSizing: 'border-box',
        minHeight: '100vh',
        padding: 'var(--p-space-4)',
        background: 'var(--p-background)',
        color: 'var(--p-text)',
        font: 'var(--p-font-body) / var(--p-line-body) var(--p-font)',
      }}
    >
      <h1 style={{ fontSize: 'var(--p-font-heading)', lineHeight: 'var(--p-line-heading)' }}>{STUDENT_COPY.waitingTitle}</h1>
      <p>{STUDENT_COPY.waitingBody}</p>
    </main>
  );
}

// Root of every surface. Unknown paths and '/' show the waiting screen.
export function App() {
  const { pathname, search } = window.location;
  const runId = new URLSearchParams(search).get('runId');
  const Page = SURFACES[pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname];
  return Page ? (
    <Suspense fallback={null}>
      <Page runId={runId} />
    </Suspense>
  ) : (
    <Waiting />
  );
}
