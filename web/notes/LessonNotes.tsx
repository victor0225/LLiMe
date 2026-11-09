import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { LESSON_NOTES_COPY } from '@core/copy';
import { HTTP_STATUS, LESSON_TEXT_MAX_BYTES, type LessonStatus, ROUTES, routePath, utf8ByteLength } from '@core/routes';
import { createEventStore } from '../lib/event-store';
import { Mascot } from '../student/Mascot';
import { isSavable, kilobytes, readTranscriptFile, transcriptLines } from './transcript';
import './notes.css';

// ready → recording → stopped → saving → started, with saveFailed after a failed save. The record
// control only frames the class: nothing is captured, and Stop reveals the prepared transcript.
export type LessonPhase = 'ready' | 'recording' | 'stopped' | 'saving' | 'started' | 'saveFailed';

type Transcript = { readonly text: string; readonly fileName: string | null };

export type LessonNotesScreenProps = {
  // The prepared transcript, or null when the server could not serve it.
  readonly prepared: string | null;
  // Writes the run's inbox file; rejects when the save did not happen.
  readonly save: (text: string) => Promise<void>;
  readonly initialPhase?: LessonPhase;
  readonly initialSeconds?: number;
};

const SECOND_MS = 1000;
const STARTED_MASCOT_PX = 220;

export function LessonNotesScreen({ prepared, save, initialPhase = 'ready', initialSeconds = 0 }: LessonNotesScreenProps) {
  const [phase, setPhase] = useState<LessonPhase>(initialPhase);
  const [seconds, setSeconds] = useState(initialSeconds);
  const [transcript, setTranscript] = useState<Transcript | null>(prepared === null ? null : { text: prepared, fileName: null });
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const headingId = useId();

  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setInterval(() => setSeconds((s) => s + 1), SECOND_MS);
    return () => clearInterval(timer);
  }, [phase]);

  if (phase === 'started') return <LessonStarted />;

  const isBeforeStop = phase === 'ready' || phase === 'recording';
  const text = transcript?.text ?? '';
  const bytes = utf8ByteLength(text);
  const canFinish = (phase === 'stopped' || phase === 'saveFailed') && isSavable(text);
  const canLoadFile = phase === 'stopped' || phase === 'saveFailed';

  const startRecording = () => {
    setSeconds(0);
    setPhase('recording');
  };
  const finish = async () => {
    setPhase('saving');
    try {
      await save(text);
      setPhase('started');
    } catch {
      setPhase('saveFailed');
    }
  };
  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    const loaded = await readTranscriptFile(file);
    if (!loaded.ok) return setFileError(loaded.error);
    setFileError(null);
    setTranscript({ text: loaded.text, fileName: loaded.name });
  };

  return (
    <LessonFrame>
      <div className="notes-body">
        <section className="notes-recorder">
          <RecordControl phase={phase} onStart={startRecording} onStop={() => setPhase('stopped')} />
          <RecordStatus phase={phase} seconds={seconds} />
        </section>
        <section className="notes-transcript" aria-labelledby={headingId}>
          <div className="notes-panel-head">
            <h2 id={headingId}>{LESSON_NOTES_COPY.transcriptHeading}</h2>
            {canLoadFile && text && (
              <button type="button" className="p-button" data-variant="secondary" onClick={() => fileInput.current?.click()}>
                {LESSON_NOTES_COPY.loadFile}
              </button>
            )}
          </div>
          {isBeforeStop && <p className="notes-empty">{phase === 'recording' ? LESSON_NOTES_COPY.recordingPanel : LESSON_NOTES_COPY.readyPanel}</p>}
          {!isBeforeStop && !text && (
            <div className="notes-empty">
              <p>{LESSON_NOTES_COPY.preparedUnavailable}</p>
              {canLoadFile && (
                <button type="button" className="p-button" data-variant="secondary" onClick={() => fileInput.current?.click()}>
                  {LESSON_NOTES_COPY.loadFile}
                </button>
              )}
            </div>
          )}
          {!isBeforeStop && text && (
            <>
              <p className="notes-meta">
                {LESSON_NOTES_COPY.loadedMeta(transcriptLines(text).length, kilobytes(bytes), transcript?.fileName ?? LESSON_NOTES_COPY.preparedSourceLabel)}
              </p>
              <TranscriptList text={text} labelledBy={headingId} />
            </>
          )}
          {fileError && (
            <p className="notes-error" role="alert">
              {fileError}
            </p>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".txt,text/plain"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              void loadFile(file);
            }}
          />
        </section>
      </div>
      <footer className="notes-footer">
        <FooterNote phase={phase} isTooLarge={bytes > LESSON_TEXT_MAX_BYTES} />
        <button type="button" className="p-button notes-finish" disabled={!canFinish} aria-busy={phase === 'saving'} onClick={() => void finish()}>
          {phase === 'saving' ? LESSON_NOTES_COPY.saving : phase === 'saveFailed' ? LESSON_NOTES_COPY.retrySave : LESSON_NOTES_COPY.finish}
        </button>
      </footer>
    </LessonFrame>
  );
}

function LessonFrame({ children, isBusy = false }: { children: ReactNode; isBusy?: boolean }) {
  return (
    <main className="notes-app" aria-busy={isBusy}>
      <header className="notes-header">
        <h1>{LESSON_NOTES_COPY.header}</h1>
        <p className="notes-class">{LESSON_NOTES_COPY.classLabel}</p>
      </header>
      {children}
    </main>
  );
}

function LessonStarted() {
  return (
    <LessonFrame>
      <section className="notes-started" role="status">
        <Mascot state="thinking" size={STARTED_MASCOT_PX} />
        <h2>{LESSON_NOTES_COPY.startedHeading}</h2>
        <p>{LESSON_NOTES_COPY.startedBody}</p>
      </section>
    </LessonFrame>
  );
}

function RecordControl({ phase, onStart, onStop }: { phase: LessonPhase; onStart: () => void; onStop: () => void }) {
  if (phase === 'recording') {
    return (
      <button type="button" className="notes-record" data-variant="stop" onClick={onStop}>
        <StopIcon />
        <span>{LESSON_NOTES_COPY.stopRecording}</span>
      </button>
    );
  }
  const isReady = phase === 'ready';
  return (
    <button type="button" className="notes-record" data-variant="record" disabled={!isReady} onClick={onStart}>
      <MicrophoneIcon />
      <span>{isReady ? LESSON_NOTES_COPY.startRecording : LESSON_NOTES_COPY.recordingStopped}</span>
    </button>
  );
}

function RecordStatus({ phase, seconds }: { phase: LessonPhase; seconds: number }) {
  if (phase === 'ready') return <p className="notes-record-status">{LESSON_NOTES_COPY.readyStatus}</p>;
  if (phase === 'recording') {
    return (
      <p className="notes-record-status">
        <span className="notes-dot" aria-hidden="true" />
        <span className="notes-time">{LESSON_NOTES_COPY.recordingStatus(seconds)}</span>
      </p>
    );
  }
  return (
    <p className="notes-record-status">
      <span className="notes-time">{LESSON_NOTES_COPY.stoppedStatus(seconds)}</span>
    </p>
  );
}

function TranscriptList({ text, labelledBy }: { text: string; labelledBy: string }) {
  const lines = useMemo(() => transcriptLines(text), [text]);
  return (
    // Focusable so keyboard users can scroll the only scrolling region on the page.
    <ol className="notes-lines" aria-labelledby={labelledBy} tabIndex={0}>
      {lines.map((line, index) => (
        <li key={index}>
          <span className="notes-line-time">{line.time}</span>
          <span className="notes-line-speaker">{line.speaker}</span>
          <span className="notes-line-text">{line.text}</span>
        </li>
      ))}
    </ol>
  );
}

function FooterNote({ phase, isTooLarge }: { phase: LessonPhase; isTooLarge: boolean }) {
  const note =
    phase === 'saveFailed'
      ? LESSON_NOTES_COPY.saveFailed
      : phase === 'saving'
        ? ''
        : isTooLarge && phase === 'stopped'
          ? LESSON_NOTES_COPY.textTooLarge
          : phase === 'stopped'
            ? LESSON_NOTES_COPY.stoppedFooter
            : LESSON_NOTES_COPY.readyFooter;
  return (
    <p className="notes-footer-note" role="status" data-tone={phase === 'saveFailed' ? 'error' : undefined}>
      {note}
    </p>
  );
}

const MicrophoneIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
    <path d="M6 11a6 6 0 0 0 12 0M12 17v4M8.5 21h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const StopIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
  </svg>
);

// ---------------------------------------------------------------------------------------------
// The /lesson-notes page: reads the run's lesson status and saves through the run's command queue.

type LessonLoad = { kind: 'loading' } | { kind: 'unknownRun' } | { kind: 'loaded'; status: LessonStatus | null };

async function loadLessonStatus(runId: string): Promise<LessonLoad> {
  try {
    const response = await fetch(routePath('getLesson', { runId }), { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (response.status === HTTP_STATUS.notFound) return { kind: 'unknownRun' };
    if (!response.ok) return { kind: 'loaded', status: null };
    const status = ROUTES.getLesson.response.safeParse(await response.json());
    return { kind: 'loaded', status: status.success ? status.data : null };
  } catch {
    // Unreachable server: the page still works up to saving, and a failed save says so.
    return { kind: 'loaded', status: null };
  }
}

export function LessonNotes({ runId }: { runId: string | null }) {
  const [load, setLoad] = useState<LessonLoad>(runId ? { kind: 'loading' } : { kind: 'unknownRun' });
  const store = useMemo(() => (runId ? createEventStore(runId) : null), [runId]);

  useEffect(() => {
    document.title = LESSON_NOTES_COPY.title;
    if (!runId) return;
    let isCurrent = true;
    void loadLessonStatus(runId).then((next) => isCurrent && setLoad(next));
    return () => {
      isCurrent = false;
    };
  }, [runId]);

  if (load.kind === 'loading') return <LessonFrame isBusy>{null}</LessonFrame>;
  if (load.kind === 'unknownRun' || !store) {
    return (
      <LessonFrame>
        <p className="notes-unavailable">{LESSON_NOTES_COPY.runUnavailable}</p>
      </LessonFrame>
    );
  }
  const save = async (text: string) => {
    await store.sendRunCommand('saveLesson', () => ({ text }));
  };
  return (
    <LessonNotesScreen
      prepared={load.status?.prepared?.text ?? null}
      save={save}
      initialPhase={load.status?.saved ? 'started' : 'ready'}
    />
  );
}
