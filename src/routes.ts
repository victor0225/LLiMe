// HTTP routes with their request and response schemas. Isomorphic: the server, the browser fetch
// helpers and the tests share these definitions. Commands are POSTed; state is read by polling
// persisted events (no server push).
import { z } from 'zod';
import {
  CommandSchema,
  ErrorBodySchema,
  type ErrorCode,
  ExplanationTextSchema,
  IdSchema,
  RunCreateInputSchema,
} from './domain.js';
import { EventSchema, RunSnapshotSchema } from './events.js';

// Request size limits enforced before parsing (413 when exceeded).
export const MAX_JSON_BODY_BYTES = 64 * 1024;
export const LESSON_TEXT_MAX_BYTES = 16 * 1024;
export const SDP_MAX_BYTES = 64 * 1024;

// The browser sends this header on every POST; it guards local mutations from unrelated pages.
export const SESSION_HEADER = 'x-primer-session';

// Size limits count UTF-8 bytes. The server checks them before parsing so an oversized body is a 413.
export const utf8ByteLength = (text: string) => new TextEncoder().encode(text).length;

export const HTTP_STATUS = {
  ok: 200,
  created: 201,
  accepted: 202,
  badRequest: 400,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  payloadTooLarge: 413,
  unprocessable: 422,
  internalError: 500,
  unavailable: 503,
} as const;

// HTTP status for each error code a route can return. 409 bodies must carry the current revision.
export const ERROR_HTTP_STATUS = {
  INVALID_INPUT: HTTP_STATUS.badRequest,
  NOT_FOUND: HTTP_STATUS.notFound,
  CONFLICT: HTTP_STATUS.conflict,
  STALE_REVISION: HTTP_STATUS.conflict,
  WRONG_PHASE: HTTP_STATUS.conflict,
  PAYLOAD_TOO_LARGE: HTTP_STATUS.payloadTooLarge,
  VALIDATION_FAILED: HTTP_STATUS.unprocessable,
  RUNTIME_DISCONNECTED: HTTP_STATUS.unavailable,
  FORBIDDEN: HTTP_STATUS.forbidden,
  INTERNAL: HTTP_STATUS.internalError,
  NOT_READY: HTTP_STATUS.unavailable,
} as const satisfies Partial<Record<ErrorCode, number>>;
export type HttpErrorCode = keyof typeof ERROR_HTTP_STATUS;

export const HttpErrorSchema = ErrorBodySchema.refine(
  (e) => !(e.code in ERROR_HTTP_STATUS && ERROR_HTTP_STATUS[e.code as HttpErrorCode] === HTTP_STATUS.conflict) || e.revision !== undefined,
  { message: 'A 409 error carries the current run revision', path: ['revision'] },
).refine((e) => e.code !== 'INTERNAL' || e.errorId !== undefined, { message: 'A 500 error carries a safe error ID', path: ['errorId'] });

// ---------------------------------------------------------------------------------------------
// Request and response bodies.

export const BootstrapSchema = z.strictObject({
  nonce: z.string().min(1),
  voice: z.enum(['configured_unverified', 'missing_key']),
  inputMode: z.enum(['live', 'typed']),
  runtime: z.string().min(1),
  database: z.string().min(1),
  dataset: z.string().min(1),
});
export type Bootstrap = z.infer<typeof BootstrapSchema>;

// Query strings arrive as text; only a plain non-negative safe integer is a valid cursor.
export const EventsQuerySchema = z.strictObject({
  after: z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number).pipe(z.number().int().max(Number.MAX_SAFE_INTEGER)),
});

export const LessonStatusSchema = z.strictObject({
  inboxFile: z.string().min(1),
  saved: z.boolean(),
  contentHash: z.string().nullable(),
  // Present only when the prepared transcript matches its manifest hash.
  prepared: z.strictObject({ text: z.string(), sha256: z.string() }).nullable(),
}).refine((s) => s.saved === (s.contentHash !== null), { message: 'contentHash is set exactly when the lesson is saved' });
export type LessonStatus = z.infer<typeof LessonStatusSchema>;

export const LessonSaveInputSchema = z.strictObject({
  text: z.string().refine((t) => t.trim().length > 0, 'The lesson is empty').refine((t) => utf8ByteLength(t) <= LESSON_TEXT_MAX_BYTES, 'The lesson is larger than 16 KB'),
});
export const LessonSaveOutputSchema = z.strictObject({ saved: z.literal(true), contentHash: z.string() });

export const VoiceSessionStatusSchema = z.enum(['connecting', 'live', 'closed', 'expired', 'failed']);
export type VoiceSessionStatus = z.infer<typeof VoiceSessionStatusSchema>;

export const VoiceSessionInputSchema = z.strictObject({
  commandId: z.uuid(),
  expectedRevision: z.number().int().min(0),
  sdpOffer: z.string().startsWith('v=0').refine((sdp) => utf8ByteLength(sdp) <= SDP_MAX_BYTES, 'The SDP offer is too large'),
});
// No key, upstream header or provider credential ever appears in this response.
export const VoiceSessionOutputSchema = z.strictObject({
  voiceSessionId: IdSchema,
  sdpAnswer: z.string().min(1),
  status: VoiceSessionStatusSchema,
});

// Audio gate: open while microphone and playback may run; closed once local teardown was acknowledged.
export const VoiceSnapshotSchema = z.strictObject({
  voiceSessionId: IdSchema.nullable(),
  status: VoiceSessionStatusSchema.nullable(),
  activeOperationId: IdSchema.nullable(),
  explanationRevision: z.number().int().min(0),
  cancellationEpoch: z.number().int().min(0),
  audioGate: z.enum(['open', 'closed']),
});
export type VoiceSnapshot = z.infer<typeof VoiceSnapshotSchema>;

const voiceCommandBase = { commandId: z.uuid(), expectedRunRevision: z.number().int().min(0) };

// Sent only after the activity's controls actually mounted. It confirms rendering; it never grades
// an attempt or advances a learning phase.
export const ActivityRenderedCommandSchema = z.strictObject({
  type: z.literal('activity_rendered'),
  ...voiceCommandBase,
  voiceSessionId: IdSchema.nullable(),
  activityId: IdSchema,
  activityRevision: z.number().int().min(0),
  specHash: z.string().min(1).nullable(),
});
export type ActivityRenderedCommand = z.infer<typeof ActivityRenderedCommandSchema>;

export const VoiceCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('close_voice'), ...voiceCommandBase, voiceSessionId: IdSchema }),
  // Acknowledges actual local microphone and playback teardown; it cannot grade learning.
  z.strictObject({ type: z.literal('audio_gate_closed'), ...voiceCommandBase, voiceSessionId: IdSchema }),
  // Same correction transition as the `explain` command, labeled as typed input.
  z.strictObject({ type: z.literal('typed_correction'), ...voiceCommandBase, voiceSessionId: IdSchema.nullable(), text: ExplanationTextSchema }),
  ActivityRenderedCommandSchema,
]);
export type VoiceCommand = z.infer<typeof VoiceCommandSchema>;

// typed_correction and activity_rendered change run state and return the run snapshot; the others
// return only session fields, after which the client reloads the run before its next mutation.
export const VoiceCommandOutputSchema = z.union([RunSnapshotSchema, VoiceSnapshotSchema]);

// A real notification tap whose activity resolves server-side. Opening is not consent to start the
// activity; the tap is deduplicated by notificationId.
export const NotificationOpenedInputSchema = z.strictObject({
  commandId: z.uuid(),
  activityId: IdSchema,
  activityRevision: z.number().int().min(0),
});

// ---------------------------------------------------------------------------------------------
// Route table.

type RouteDef = {
  method: 'GET' | 'POST';
  path: string;
  status: number;
  request: z.ZodType | null;
  query: z.ZodType | null;
  response: z.ZodType;
  errors: readonly number[];
};

// Host validation applies to every request, so every route can answer 403.
const runErrors = [HTTP_STATUS.forbidden, HTTP_STATUS.notFound] as const;
const commandErrors = [HTTP_STATUS.badRequest, HTTP_STATUS.forbidden, HTTP_STATUS.notFound, HTTP_STATUS.conflict, HTTP_STATUS.payloadTooLarge, HTTP_STATUS.unprocessable, HTTP_STATUS.unavailable] as const;

export const ROUTES = {
  bootstrap: { method: 'GET', path: '/api/bootstrap', status: HTTP_STATUS.ok, request: null, query: null, response: BootstrapSchema, errors: [HTTP_STATUS.forbidden] },
  createRun: { method: 'POST', path: '/api/runs', status: HTTP_STATUS.created, request: RunCreateInputSchema, query: null, response: RunSnapshotSchema, errors: [HTTP_STATUS.badRequest, HTTP_STATUS.forbidden, HTTP_STATUS.payloadTooLarge, HTTP_STATUS.unavailable] },
  getRun: { method: 'GET', path: '/api/runs/:runId', status: HTTP_STATUS.ok, request: null, query: null, response: RunSnapshotSchema, errors: runErrors },
  runEvents: { method: 'GET', path: '/api/runs/:runId/events', status: HTTP_STATUS.ok, request: null, query: EventsQuerySchema, response: z.array(EventSchema), errors: [HTTP_STATUS.badRequest, HTTP_STATUS.forbidden, HTTP_STATUS.notFound] },
  runCommand: { method: 'POST', path: '/api/runs/:runId/commands', status: HTTP_STATUS.ok, request: CommandSchema, query: null, response: RunSnapshotSchema, errors: commandErrors },
  getLesson: { method: 'GET', path: '/api/runs/:runId/lesson', status: HTTP_STATUS.ok, request: null, query: null, response: LessonStatusSchema, errors: runErrors },
  // Writes the run's inbox file only; the inbox watcher is the sole trigger for ingestion.
  saveLesson: { method: 'POST', path: '/api/runs/:runId/lesson', status: HTTP_STATUS.accepted, request: LessonSaveInputSchema, query: null, response: LessonSaveOutputSchema, errors: [HTTP_STATUS.badRequest, HTTP_STATUS.forbidden, HTTP_STATUS.notFound, HTTP_STATUS.conflict, HTTP_STATUS.payloadTooLarge] },
  createVoiceSession: { method: 'POST', path: '/api/runs/:runId/voice/session', status: HTTP_STATUS.created, request: VoiceSessionInputSchema, query: null, response: VoiceSessionOutputSchema, errors: commandErrors },
  voiceSnapshot: { method: 'GET', path: '/api/runs/:runId/voice/snapshot', status: HTTP_STATUS.ok, request: null, query: null, response: VoiceSnapshotSchema, errors: runErrors },
  notificationOpened: { method: 'POST', path: '/api/runs/:runId/notifications/:notificationId/opened', status: HTTP_STATUS.ok, request: NotificationOpenedInputSchema, query: null, response: RunSnapshotSchema, errors: [HTTP_STATUS.badRequest, HTTP_STATUS.forbidden, HTTP_STATUS.notFound, HTTP_STATUS.conflict, HTTP_STATUS.payloadTooLarge] },
  voiceCommand: { method: 'POST', path: '/api/runs/:runId/voice/commands', status: HTTP_STATUS.ok, request: VoiceCommandSchema, query: null, response: VoiceCommandOutputSchema, errors: commandErrors },
} as const satisfies Record<string, RouteDef>;
export type RouteName = keyof typeof ROUTES;

// Builds a concrete path from a route pattern, encoding every parameter.
export function routePath(name: RouteName, params: { runId?: string; notificationId?: string } = {}): string {
  return ROUTES[name].path.replace(/:(runId|notificationId)/g, (_match, key: 'runId' | 'notificationId') => {
    const value = params[key];
    if (value === undefined) throw new Error(`Route ${name} needs a ${key}`);
    return encodeURIComponent(value);
  });
}
