# Engineering QA

This page records what was tested, how, and what is still unproven. It is engineering evidence, not the demo film.

**Statuses.** **PASS**: the scenario ran against the integrated build and met its required result. **FAIL**: it ran and did not; **FAIL (open)** means the fix is not merged yet. **UNPROVED**: it did not run, or a dependency was missing, so nothing is claimed. A screenshot never counts as proof of a database transaction, and a tool acknowledgment never counts as proof that audio was heard.

**Evidence.** Each scenario's commands, outputs, run IDs and screenshots are kept with the release capture. They are not committed to this repository.

## Automated suites

| Suite | Result |
| --- | --- |
| `npm run typecheck` (server and web) | exit 0 |
| `npm test` (node:test, no model calls) | TODO(qa): count at the final commit (778/778 at `ac24c48`) |
| `npm run test:e2e` (Playwright + axe), per surface | explain 28, number line 27, invitation and lesson notes 34, make-ten 26, inspector 30, graph 10: all passing |
| iPad shell unit tests (`xcodebuild test`) | 30/30 |
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
| L07 | Problem selection by seed: invalid seeds refused, the selected pair survives refresh and restart, the film seed gives 8 + 5 then 9 + 4 | PASS | |

## Voice, delegation and execution

| ID | Scenario | Status | Notes |
| --- | --- | --- | --- |
| V01 | One voice session, credential kept server-side, sideband attached to the same session | PASS | Live, in the app |
| V02 | Spoken explanation delegated with its offset; a late fragment revises the same explanation | TODO(qa) | |
| V03 | Published support reaches the UI with matching spoken commentary | PASS | Live, in the app |
| V04 | A correction during an active turn steers that turn with a new explanation revision | FAIL (open) | Tool calls in the steered turn are refused |
| V05 | A correction racing a completed turn, before and after practice submission | TODO(qa) | |
| V06 | A duplicate delegation or provider event gives one logical analysis | TODO(qa) | |
| V07 | Sideband disconnect or microphone denied gives an explicit degraded state and the typed path | TODO(qa) | |
| V08 | Stop learning during analysis and practice; late results and resumes are refused | TODO(qa) | |
| V09 | A correction after speech begins stops the obsolete playback | TODO(qa) | |
| V10 | Voice is fully off before the independent problem is enabled | PASS | Live, in the app |
| V11 | Closing or reloading the page closes the session within bounds | TODO(qa) | |
| V12 | Instruction-like text in a transcript is treated as learner data | FAIL (open) | The voice model answered an injected instruction itself, with a hint |

## Graph, ranking and outcomes

| ID | Scenario | Status | Notes |
| --- | --- | --- | --- |
| G01 | Same labels with different edges or directions change the score | TODO(qa) | |
| G02 | Same shape with a different hypothesis meaning scores lower | TODO(qa) | |
| G03 | Renamed IDs, reordered arrays and moved coordinates leave scores unchanged | TODO(qa) | |
| G04 | Changing only outcome or strategy leaves similarity unchanged | TODO(qa) | |
| G05 | The same learner, another concept and future cases are excluded | TODO(qa) | |
| G06 | Every decision layer: clarify, slip policy, evidence, default; repeat-count never chosen; a mismatched publish refused | TODO(qa) | |
| G07 | Every matched path pair resolves to real edges | TODO(qa) | |
| G08 | An invalid node, edge or quote is rejected before any write | TODO(qa) | |
| G09 | Context and outcome nodes appear only after their own commits | PASS | Live |
| G10 | Hints or invalid moves cannot earn an independent pass; correct assisted practice advances to the check | TODO(qa) | |
| G11 | A real hint-free attempt saves narrow independent evidence | PASS | Live, after the fix in `f1345ff`: the outcome is committed once, the run is COMPLETE, and the child sees "You solved a new problem without help." Before the fix the verification turn ended in ERROR |
| G12 | Novel hypothesis (engineering only, never filmed): clarifies despite passing scores, the name shows only in the inspector, invalid variants are refused | FAIL (open) | Starting a turn while the previous one is finishing ends in ERROR, also at the boundary between ingestion and explanation |

## Persistence, mobile and visualization

| ID | Scenario | Status | Notes |
| --- | --- | --- | --- |
| P01 | A duplicate command returns the original receipt; a changed payload conflicts | TODO(qa) | |
| P02 | A crash around publication leaves no half-published activity | TODO(qa) | |
| P03 | Restart during ingestion, explanation and verification keeps committed work and never reruns model work | TODO(qa) | |
| P04 | Export and replay are read-only; inspector refresh shows each tool call exactly once | TODO(qa) | |
| M01 | Notification permission granted and denied in the Simulator | TODO(qa) | |
| M02 | The OS notification arrives after the commit with opaque IDs only | TODO(qa) | |
| M03 | Tapping the notification, warm and cold, opens the exact activity and still asks before starting | TODO(qa) | |
| M04 | Stale activity, offline backend or duplicate tap gives an honest unavailable or retry state | TODO(qa) | |
| M05 | Voice inside the iPad web view: permission, audio and teardown | TODO(qa) | |
| M06 | Rotating the iPad keeps the activity, moves and attempt | TODO(qa) | |
| X01 | The search view shows the actual matched branches | TODO(qa) | |
| X02 | Class-memory scene | UNPROVED | Not built; outside the demo |

## Child UI

| ID | Scenario | Status | Notes |
| --- | --- | --- | --- |
| UI01–UI02 | Invitation: Let's try and Later are distinct; nothing starts automatically | TODO(qa) | |
| UI03–UI04 | Number line: moves, undo and bounds | TODO(qa) | |
| UI05–UI08 | Listening, thinking, typed fallback and disconnected states | TODO(qa) | |
| UI09–UI11 | Independent check, saved versus assisted copy, empty and loading states | TODO(qa) | |
| UI12–UI15 | Keyboard focus, small widths and zoom, reduced motion, contrast and target sizes | TODO(qa) | |
| UI16 | Every Storybook story loads without errors or provider requests | TODO(qa) | |

## Generated activities

| ID | Scenario | Status | Notes |
| --- | --- | --- | --- |
| GUI01 | The support activity records exact moves and help exposure | PASS | |
| GUI02 | The independent activity has no marker, scaffold or preset start | PASS | |
| GUI03 | Unknown props, wrong math, stale revision or forged evidence is rejected before render | PASS | |
| GUI04 | Real Codex receives the component catalog and returns an accepted spec | PASS | |
| GUI05 | `publish_activity` commits a generated spec atomically | PASS | |
| GUI06 | Speech waits for the matching render acknowledgment | TODO(qa) | |
| GUI07 | No unsolicited replacement while the child is moving objects | FAIL (open) | A replacement shifts the make-ten workspace by 80 px |
| GUI08 | A falsified hint count from the client is ignored | PASS | |

Make-ten workspace checks:

| Check | Status |
| --- | --- |
| Object count is conserved while moving | PASS |
| Undo | PASS |
| Fixed appearance in the browser | PASS |
| Support equation derived from object positions | PASS |
| Appearance excluded from similarity | UNPROVED |

## Fixed during QA

- The first support publish on the main run was rejected because the explanation prompt did not say that the lesson concept and quotes are empty for support activities. Fixed in `f1345ff`.
- `demo:reset -- --case main` picked a random problem seed instead of the film seed. Fixed in `993c1ed`; L01 and L07 passed again afterwards.

## Engineering checks outside the film

These checks are engineering QA only and never appear in the film.

| Check | Status |
| --- | --- |
| Alternate explanation on a separate run ("I missed one tap.") | Not run. `npm run demo:reset -- --case contrast` creates such a run; the automatic comparison between runs is not implemented. |
| A second problem seed (for example one giving 6 + 6) | Not run |
| Novel hypothesis (G12) | FAIL (open); see G12 |
