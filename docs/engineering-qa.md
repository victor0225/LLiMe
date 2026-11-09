# Engineering QA

This page records what was tested, how, and what is still unproven. It is engineering evidence, not the demo film.

**Statuses.** **PASS**: the scenario ran against the integrated build and met its required result. **FAIL**: it ran and did not. **UNPROVED**: it did not run, or a dependency was missing, so nothing is claimed. A screenshot never counts as proof of a database transaction, and a tool acknowledgment never counts as proof that audio was heard.

**Evidence paths** are relative to the checkout on the machine that ran the scenario, under `.runtime/` (gitignored). They are kept with the run's capture and are not committed to this repository.

## Automated suite

| Check | Commit | Result |
| --- | --- | --- |
| `npm run typecheck` (server and web) | `993c1ed` | exit 0 |
| `npm test` (node:test, no model calls) | `993c1ed` | 774 tests, 114 suites, 774 pass, 0 fail, 0 skipped |
| `npm run doctor` | `993c1ed` | 13 pass, 1 warning (Storybook port in use by another local process), 0 fail |
| `npm run test:e2e` (Playwright + axe) | — | TODO(qa) |
| iPad shell unit tests (`xcodebuild test`) | — | TODO(qa) |
| `npm run test:runtime` (live Codex smoke) | — | TODO(qa) |

The pure rules have direct unit tests: search scoring and admission (`tests/search.test.ts`, `tests/search-film.test.ts`), the decision rule (`tests/decision.test.ts`), assessment (`tests/assessment.test.ts`), the run state machine (`tests/engine.test.ts`), idempotency and transactions (`tests/store.test.ts`, `tests/outbox.test.ts`).

## Fresh install

| ID | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| BUILD01 | Clean `https` clone at `f9efd1f`: `npm ci`, `setup:env`, `db:up`, `doctor` (14/14), `dataset`, `seed` twice (781 cases, 120 learners, second run writes nothing), `typecheck`, `npm test` (774/774), `dev`, `demo:reset --case main`, `demo:drop` reaching INVITED on a real Codex App Server, `demo:export`, `live:voice`, `build`, `start`, `demo:purge` (0 nodes left), `build-storybook` | PASS | `.runtime/captures/tasks/task_8f8f5682c529/fresh/BUILD01/summary.md`, command log `fresh-commands.log` (SHA-256 `1431a09f6489c09b3176ca9282b113af9a33bf5c768faa0e118cf457ce772190`) |
| BUILD01 (part) | Cold first start of Neo4j | UNPROVED | No exclusive database window; the shared service was never stopped |

The clone ran on a build Mac that already had the database credential, Docker images and caches, so it is not a bare-machine install.

## Lesson and invitation

| ID | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| L01 | Saving the main transcript triggers real Codex ingestion, a real memory tool call with source quotes, and a committed invitation with its outbox row | PASS | TODO(qa): exact receipt path under `.runtime/captures/lesson/` |
| L02 | An unrelated lesson, or no eligible memory, gives no invitation and an honest no-match state | PASS | TODO(qa): exact receipt path under `.runtime/captures/lesson/` |
| L03 | The same content saved twice, or a partial file, is processed once | PASS | TODO(qa): exact receipt path under `.runtime/captures/lesson/` |
| L04 | A provider timeout or an invalid quote before the commit gives no publication and no notification | UNPROVED | No fault-injection seam |
| L05 | Lesson notes: Start, Stop and Finish save the prepared text unchanged with no audio captured; a loaded file saves as shown; bad files are refused | PASS | TODO(qa): exact receipt path under `.runtime/captures/lesson/` |
| L06 | Invitation eligibility: invalid concept, quote or evidence is rejected; curriculum links resolve; 18 subtraction and 0 addition cases are summarized and 8 returned | UNPROVED (in part) | Parts that need fault injection did not run. TODO(qa): list the parts that passed |
| L07 | Problem selection by seed: invalid seeds refused, the selected pair survives refresh and restart, the film seed gives 8 + 5 then 9 + 4 | PASS | TODO(qa): exact receipt path under `.runtime/captures/lesson/` |

## Voice, delegation and execution

| ID | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| V01 | One voice session, credential kept server-side, sideband attached to the same session | TODO(qa) | |
| V02 | Spoken explanation delegated with its offset; a late fragment revises the same explanation | TODO(qa) | |
| V03 | Published support reaches the UI and matching spoken commentary | TODO(qa) | |
| V04 | A correction during an active turn steers that turn with a new explanation revision | FAIL (open) | Tool calls in the steered turn are refused; fix in progress |
| V05 | A correction racing a completed turn, before and after practice submission | TODO(qa) | |
| V06 | A duplicate delegation or provider event gives one logical analysis | TODO(qa) | |
| V07 | Sideband disconnect or microphone denied gives an explicit degraded state and the typed path | TODO(qa) | |
| V08 | Stop learning during analysis and practice; late results and resumes are refused | TODO(qa) | |
| V09 | A correction after speech begins stops the obsolete playback | TODO(qa) | |
| V10 | Voice is fully off before the independent problem is enabled | TODO(qa) | |
| V11 | Closing or reloading the page closes the session within bounds | TODO(qa) | |
| V12 | Instruction-like text in a transcript is treated as learner data | TODO(qa) | |

## Graph, ranking and outcomes

| ID | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| G01 | Same labels with different edges or directions change the score | TODO(qa) | |
| G02 | Same shape with a different hypothesis meaning scores lower | TODO(qa) | |
| G03 | Renamed IDs, reordered arrays and moved coordinates leave scores unchanged | TODO(qa) | |
| G04 | Changing only outcome or strategy leaves similarity unchanged | TODO(qa) | |
| G05 | The same learner, another concept and future cases are excluded | TODO(qa) | |
| G06 | Every decision layer: clarify, slip policy, evidence, default; repeat-count never chosen; a mismatched publish refused | TODO(qa) | |
| G07 | Every matched path pair resolves to real edges | TODO(qa) | |
| G08 | An invalid node, edge or quote is rejected before any write | TODO(qa) | |
| G09 | Context and outcome nodes appear only after their own commits | TODO(qa) | |
| G10 | Hints or invalid moves cannot earn an independent pass; correct assisted practice advances to the check | TODO(qa) | |
| G11 | A real hint-free attempt saves narrow independent evidence | FAIL (open) | The verification turn ends in ERROR on the main run; fix in progress |
| G12 | Novel hypothesis (engineering only, never filmed): clarifies despite passing scores, the name shows only in the inspector, invalid variants are refused | FAIL (open) | Starting a turn while the previous one is finishing ends in ERROR; fix in progress |

## Persistence, mobile and visualization

| ID | Scenario | Status | Evidence |
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

| ID | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| UI01–UI02 | Invitation: Let's try and Later are distinct, nothing starts automatically | TODO(qa) | |
| UI03–UI04 | Number line: moves, undo and bounds | TODO(qa) | |
| UI05–UI08 | Listening, thinking, typed fallback and disconnected states | TODO(qa) | |
| UI09–UI11 | Independent check, saved versus assisted copy, empty and loading states | TODO(qa) | |
| UI12–UI15 | Keyboard focus, small widths and zoom, reduced motion, contrast and target sizes | TODO(qa) | |
| UI16 | Every Storybook story loads without errors or provider requests | TODO(qa) | |

## Generated activities

| ID | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| GUI01 | Support activity records exact moves and help exposure | TODO(qa) | |
| GUI02 | The independent activity has no marker, scaffold or preset start | TODO(qa) | |
| GUI03 | Unknown props, wrong math, stale revision or forged evidence is rejected before render | TODO(qa) | |
| GUI04 | Real Codex receives the component catalog and returns an accepted spec | TODO(qa) | |
| GUI05 | `publish_activity` commits a generated spec atomically | FAIL (open) | The first support publish is rejected on the main run; prompt fix in progress |
| GUI06 | Speech waits for the matching render acknowledgment | TODO(qa) | |
| GUI07 | No unsolicited replacement while the child is moving objects | TODO(qa) | |
| GUI08 | A falsified hint count from the client is ignored | TODO(qa) | |

## Engineering checks outside the film

These checks are engineering QA only and never appear in the film.

| Check | Status | Notes |
| --- | --- | --- |
| Alternate explanation on a separate run ("I missed one tap.") | TODO(qa) | `npm run demo:reset -- --case contrast` creates the run. The automatic comparison (`demo:compare`) is not implemented. |
| A second problem seed (for example one giving 6 + 6) | TODO(qa) | |
| Novel hypothesis (G12) | FAIL (open) | See G12 |
