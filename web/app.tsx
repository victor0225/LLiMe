import { STUDENT_COPY } from '@core/copy';
import { LessonNotes } from './notes/LessonNotes';
import { StudentApp } from './student/StudentApp';

// Root of every surface. Screens join here by URL path as their lanes deliver them.
export function App() {
  const { pathname, search } = window.location;
  const runId = new URLSearchParams(search).get('runId');
  if (pathname === '/lesson-notes') return <LessonNotes runId={runId} />;
  // The iPad shell may add a trailing slash; the query is kept either way.
  if (pathname === '/student' || pathname === '/student/') return <StudentApp runId={runId} />;
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
