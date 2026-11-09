import { LESSON_NOTES_COPY } from '@core/copy';
import { LESSON_TEXT_MAX_BYTES, utf8ByteLength } from '@core/routes';

export type TranscriptLine = { readonly time: string; readonly speaker: string; readonly text: string };

// Lines starting with "# " describe the file; they are saved with it but are not spoken turns.
const HEADER = /^# /;
// "[mm:ss] Speaker: words", where the time and the speaker are both optional.
const TURN = /^(?:\[(\d{2}:\d{2})\] )?(?:([^:[\]\n]{1,40}): )?(.+)$/;

// Display only: the saved file is always the shown text, unchanged.
export function transcriptLines(text: string): TranscriptLine[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !HEADER.test(line))
    .map((line) => {
      const [, time = '', speaker = '', words = line] = TURN.exec(line) ?? [];
      return { time, speaker, text: words };
    });
}

// "2.2" for 2293 bytes, matching the "of 16 KB" limit shown beside it.
export const kilobytes = (bytes: number) => (bytes / 1024).toFixed(1);

export const isSavable = (text: string) => text.trim().length > 0 && utf8ByteLength(text) <= LESSON_TEXT_MAX_BYTES;

export type LoadedFile = { readonly ok: true; readonly text: string; readonly name: string } | { readonly ok: false; readonly error: string };

const TEXT_FILE = /\.txt$/i;

// Accepts only plain UTF-8 text within the save limit, so a loaded file can always be saved as shown.
export async function readTranscriptFile(file: File): Promise<LoadedFile> {
  if (!TEXT_FILE.test(file.name) && file.type !== 'text/plain') return { ok: false, error: LESSON_NOTES_COPY.notTextFile };
  if (file.size > LESSON_TEXT_MAX_BYTES) return { ok: false, error: LESSON_NOTES_COPY.fileTooLarge };
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()), name: file.name };
  } catch {
    return { ok: false, error: LESSON_NOTES_COPY.notUtf8 };
  }
}
