# Engineering QA

This page records what was tested, how, and what is still unproven. It is engineering evidence, not the demo film.

**Statuses.** **PASS**: the scenario ran against the integrated build and met its required result. **FAIL**: it ran and did not; **FAIL (open)** means the fix is not merged or not yet rechecked. **UNPROVED**: it did not run, or a dependency was missing, so nothing is claimed. A screenshot never counts as proof of a database transaction, and a tool acknowledgment never counts as proof that audio was heard.

**Evidence.** Each scenario's commands, outputs, run IDs and screenshots are kept with the release capture. They are not committed to this repository. Unless a row names another commit, results are from integration commit `96f36ca`.

## Automated suites

| Suite | Result |
| --- | --- |
| `npm run typecheck` (server and web) | exit 0 |
| `npm test` (node:test, no model calls) | 785/785 at `05b412c` |
| `npm run test:e2e` (Playwright + axe), per surface | explain 28, number line 27, invitation and lesson notes 34, make-ten 26, inspector 30, graph 10: all passing |
| iPad shell unit tests (`xcodebuild test`) | 30/30 |
| Server-level voice tests | 141/141 |
| `npm run test:runtime` (live Codex App Server smoke) | 3/3 |

The pure rules have direct unit tests: search scoring and admission (`tests/search.test.ts`, `tests/search-film.test.ts`), the decision rule (`tests/decision.test.ts`), assessment (`tests/assessment.test.ts`), the run state machine (`tests/engine.test.ts`), and idempotency and transactions (`tests/store.test.ts`, `tests/outbox.test.ts`).

## Fresh install

| ID | Scenario | Status | Notes |
| --- | --- | --- | --- |
| BUILD01 | Clean `https` clone at `f9efd1f`: `npm ci`, `setup:env`, `db:up`, `doctor` (14/14), `dataset`, `seed` twice (781 cases, 120 learners; the second run writes nothing), `typecheck`, `npm test` (774/774), `dev`, `demo:reset --case main`, `demo:drop` reaching INVITED on a real Codex App Server, `demo:export`, `live:voice`, `build`, `start`, `demo:purge` (0 nodes left), `build-storybook` | PASS | Ran on a build Mac that already had the database credential, Docker images and caches, so not a bare-machine install |
| BUILD01 (part) | Cold first start of Neo4j | UNPROVED | No exclusive database window; the shared service was never stopped |

## Lesson and invitation

| ID | Scenario | Status | Notes |
| --- | --- | --- | --- |
| L01 | Saving the main transcript triggers real Codex ingestion, a real memory tool call with source quotes, and a committed invitation with its outbox row | PASS | |
| L02 | An unrelated lesson gives no invitation and an honest no-match state | PASS | |
| L02 (part) | No eligible memory gives no invitation | UNPROVED | |
| L03 | The same content saved twice, or a partial file, is processed once | PASS | |
| L04 | A provider timeout or an invalid quote before the commit gives no publication and no notification | UNPROVED | No fault-injection seam |
| L05 | Lesson notes: Start, Stop and Finish save the prepared text unchanged with no audio captured; a loaded file saves as shown; bad files are refused | PASS | |
| L06 | Invitation eligibility: invalid concept, quote or evidence is rejected; curriculum links resolve; 18 subtraction and 0 addition cases are summarized and 8 returned | UNPROVED (in part) | Six sub-checks passed; the sub-checks that need fault injection did not run |
| Main run | Full QA run with the film seed (28): lesson, invitation, 8 + 5, typed explanation labelled as typed, make-ten support, hint-free 9 + 4 with no helpers, outcome committed once, COMPLETE; the export's hashes verified and its ranking hash matches the search event | PASS | |
| L07 | Problem selection by seed: invalid seeds refused, the selected pair survives refresh and restart, the film seed gives 8 + 5 then 9 + 4 | PASS | |

## Voice, delegation and execution

| ID | Scenario | Status | Notes |
| --- | --- | --- | --- |
| V01 | One voice session, credential kept server-side, sideband attached to the same session | PASS | Live, in the app |
| V02 | Spoken explanation delegated with its offset; a late fragment revises the same explanation | UNPROVED | Live delegation sealed the first revision; the delayed-fragment legs need a timed recording |
| V03 | Published support reaches the UI with matching spoken commentary | PASS | Live, in the app |
| V04 | A correction during an active turn steers that turn with a new explanation revision | PASS | After the fix in `3bd9133`; before it, tool calls in a steered turn were refused |
| V05 | A correction racing a completed turn, before and after practice submission | PASS | The after-submit leg, at `cd82d82` |
| V06 | A duplicate delegation or provider event gives one logical analysis | PASS | |
| V07 | Sideband disconnect or microphone denied gives an explicit degraded state and the typed path | PASS | Microphone denied live; sideband drop in a controlled test |
| V08 | Stop learning during analysis and practice; late results and resumes are refused | UNPROVED | Live stop during analysis behaved correctly; the practice leg was not run live |
| V09 | A correction after speech begins stops the obsolete playback | FAIL (open) | Fix merged in `05b412c`; recheck pending |
| V10 | Voice is fully off before the independent problem is enabled | PASS | Live, in the app |
| V11 | Closing or reloading the page closes the session within bounds | PASS | |
| V12 | Instruction-like text in a transcript is treated as learner data | PASS | After the voice-instruction fix; before it, the voice model answered an injected instruction itself with a hint |

Further voice checks: the second steering check and three controlled checks with a mocked Codex passed, the iPad web-view voice check passed, one check fails (open, fix in progress) and one is unproved.

## Graph, ranking and outcomes

| ID | Scenario | Status | Notes |
| --- | --- | --- | --- |
| G01 | Same labels with different edges or directions change the score | PASS | |
| G02 | Same shape with a different hypothesis meaning scores lower | PASS | |
| G03 | Renamed IDs, reordered arrays and moved coordinates leave scores unchanged | PASS | |
| G04 | Changing only outcome or strategy leaves similarity unchanged | PASS | |
| G05 | The same learner, another concept and future cases are excluded | PASS | |
| G06 | Every decision layer: clarify, slip policy, evidence, default; repeat-count never chosen; a mismatched publish refused | PASS | The browser check of the Default label was not run |
| G07 | Every matched path pair resolves to real edges | PASS | |
| G08 | An invalid node, edge or quote is rejected before any write | PASS | |
| G09 | Context and outcome nodes appear only after their own commits | PASS | No screenshot of the graph before verification |
| G10 | Hints or invalid moves cannot earn an independent pass; correct assisted practice advances to the check | PASS | |
| G11 | A real hint-free attempt saves narrow independent evidence | PASS | Live at `f1345ff`: the outcome is committed once, the run is COMPLETE, and the child sees "You solved a new problem without help." Before that fix the verification turn ended in ERROR |
| G12 | Novel hypothesis (engineering only, never filmed): clarifies despite passing scores, the name shows only in the inspector, invalid variants are refused | PASS | After the fix in `3bd9133`; before it, starting a turn while the previous one was finishing ended in ERROR |

## Persistence, mobile and visualization

| ID | Scenario | Status | Notes |
| --- | --- | --- | --- |
| P01 | A duplicate command returns the original receipt; a changed payload conflicts | PASS | |
| P02 | A crash around publication leaves no half-published activity | UNPROVED | No fault-injection hook |
| P03 | Restart during ingestion, explanation and verification keeps committed work and never reruns model work | UNPROVED (in part) | A hard kill during ingestion gives ERROR, and restarts leave committed runs unchanged; the other legs need fault hooks or an exclusive database window |
| P04 | Export and replay are read-only; inspector refresh shows each tool call exactly once | UNPROVED (in part) | The replay half passed |
| M01 | Notification permission granted and denied in the Simulator | PASS | |
| M02 | The OS notification arrives after the commit with opaque IDs only | PASS | |
| M03 | Tapping the notification, warm and cold, opens the exact activity and still asks before starting | PASS | |
| M04 | Stale activity, offline backend or duplicate tap gives an honest unavailable or retry state | PASS | After the fix in `96f36ca`; before it, a tap on a stale invitation was accepted |
| M05 | Voice inside the iPad web view: permission, audio and teardown | UNPROVED | The Simulator has no audio input, so only the typed fallback was exercised |
| M06 | Rotating the iPad keeps the activity, moves and attempt | UNPROVED (in part) | The first answer draft survives rotation; the other legs did not run |
| X01 | The search view shows the actual matched branches | PASS | Live: 659 ranked, 51 admitted, 51 shown |
| X02 | Class-memory scene | UNPROVED | Not built; outside the demo |
| iPad tap checks | Notification banner, opened activity, cold launch, second tap, stale invitation | PASS | The stale-invitation check passed after the fix in `96f36ca` |
| iPad tap checks (part) | Two further tap checks | UNPROVED | |

## Child UI

| ID | Scenario | Status | Notes |
| --- | --- | --- | --- |
| UI01 | Invitation at iPad landscape and portrait; Let's try gives one accept | PASS | |
| UI02 | Later gives one later, with no accept or attempt | PASS | |
| UI03 | Number line with the film problem: four forward moves give 12 | PASS | |
| UI04 | Undo at the start, undo after a move, and the forward bound | FAIL (open) | Fix in progress |
| UI05 | Listening and long captions at iPad portrait and phone widths | PASS | |
| UI06 | Thinking state shows no invented progress, diagnosis or outcome | PASS | |
| UI07 | Microphone denied: the typed path shares the exact trimmed text once | PASS | |
| UI08 | Disconnected: Reconnect and Type instead are distinct, with no fake recovery | PASS | Manual review |
| UI09 | Independent check: new problem, no prefilled moves, hints or microphone | UNPROVED | |
| UI10 | Saved versus assisted copy; no retention claim | PASS | Manual review |
| UI11 | Empty and loading states | PASS | |
| UI12 | Keyboard only: visible focus, order and native buttons | FAIL (open) | Fix in progress |
| UI13 | Small widths, long captions and 200% zoom | FAIL (open) | Fix in progress |
| UI14 | Reduced motion | FAIL (open) | Fix in progress |
| UI15 | Contrast, focus and touch-target sizes | PASS | Light theme; no dark theme is built |
| UI16 | Every Storybook story loads without errors or provider requests | FAIL (open) | A story's network call is fixed in `3561f5d`; recheck pending |

## Generated activities

| ID | Scenario | Status | Notes |
| --- | --- | --- | --- |
| GUI01 | The support activity records exact moves and help exposure | PASS | |
| GUI02 | The independent activity has no marker, scaffold or preset start | PASS | |
| GUI03 | Unknown props, wrong math, stale revision or forged evidence is rejected before render | PASS | |
| GUI04 | Real Codex receives the component catalog and returns an accepted spec | PASS | |
| GUI05 | `publish_activity` commits a generated spec atomically | PASS | |
| GUI06 | Speech waits for the matching render acknowledgment | UNPROVED (in part) | The receipt checks passed; speech gating is not yet tested |
| GUI07 | No unsolicited replacement while the child is moving objects | PASS | After the fix in `c404692`; before it, a refused replacement shifted the make-ten workspace by 80 px |
| GUI08 | A falsified hint count from the client is ignored | PASS | |

Make-ten workspace checks:

| Check | Status |
| --- | --- |
| Object count is conserved while moving | PASS |
| Undo | PASS |
| Fixed appearance in the browser | PASS |
| Support equation derived from object positions | PASS |
| Appearance excluded from similarity | UNPROVED |

## Found during QA

| Defect | Fix | Recheck |
| --- | --- | --- |
| The verification turn ended in ERROR on the main run | `f1345ff` | G11 PASS |
| The first support publish was rejected because the explanation prompt did not say that the lesson concept and quotes are empty for support activities | `f1345ff` | G11 live rerun passed |
| `demo:reset -- --case main` picked a random problem seed instead of the film seed | `993c1ed` | L01 and L07 PASS |
| Tool calls in a steered turn were refused; starting a turn while the previous one was finishing ended in ERROR | `3bd9133` | V04 and G12 PASS |
| The voice model answered an injected instruction itself | `17257d1` | V12 PASS |
| A refused replacement shifted the make-ten workspace | `c404692` | GUI07 PASS |
| A tap on a stale invitation was accepted | `96f36ca` | M04 PASS |
| `commit_episode` was refused when the run had moved to a newer revision during verification | retry on the reported revision | Unit tests pass; a retry with the real model is UNPROVED |
| A new voice session did not ask the child how they got their answer | `cd82d82` | PASS: "How did you get 12?" is spoken 0.4 s after the session starts |
| A correction after speech begins does not stop the obsolete playback (V09) | in progress | FAIL (open) |

## Engineering checks outside the film

These checks are engineering QA only and never appear in the film.

| Check | Status |
| --- | --- |
| Alternate explanation on a separate run ("I missed one tap.") | Not run. `npm run demo:reset -- --case contrast` creates such a run; the automatic comparison between runs is not implemented. |
| A second problem seed (for example one giving 6 + 6) | Not run |
| Novel hypothesis (G12) | PASS; see G12 |
