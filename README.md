# llime

**Education that remembers each learner and takes initiative.**

**Watch the 90-second demo:** TODO(video): add the verified video URL.

## The problem

Good teaching includes knowing when to step in, and how to make an idea click for one particular learner.

Teachers and tutors have little time to follow every learner between lessons, and one-to-one support is expensive. A tutor that waits for questions only helps learners who already know they need help and what to ask.

Choosing a useful explanation also takes more than subject knowledge. It takes context: what this learner has tried, how they approached it, and what happened when similar learners got different kinds of support.

A 2024 meta-analysis of preK–12 tutoring experiments found a pooled effect of **0.288 standard deviations** on learning outcomes ([Nickow, Oreopoulos & Quan, 2024](https://doi.org/10.3102/00028312231208687)). That supports the tutoring programs it studied. It says nothing yet about llime.

llime brings that context into action. It connects today's lesson to a **personal learning memory**, uses an **agent that takes initiative** to offer a next step, and shapes **a personalized explanation and interactive activity** around the learner's own response. An invitation is an offer to try something, not a diagnosis. This is our take on [YC's request for The Primer](https://www.ycombinator.com/rfs/): a tutor that grows with the learner and supplements teachers. Arithmetic is the first testable slice, not the boundary of the product.

## What llime does

The demo makes three mechanisms observable. Memory supplies prior evidence. The agent reads the lesson, calls tools and starts a relevant invitation. Personalization changes the representation and the explanation using what the learner did and said. The result is saved to the learner's history.

1. **Connects today's lesson to the child's history.** The demo learner has 18 earlier subtraction cases and no addition cases. Today's lesson is addition. Through the curriculum link between subtraction and addition, llime offers a short challenge on the iPad:
   > Remember taking things away in subtraction? Today, let’s put things together with addition. Want to try?

   The child chooses **Let’s try** or **Later**. Nothing starts until the child accepts.

   ![The llime notification "A quick challenge from today's lesson?" on the iPad Simulator lock screen](docs/images/ipad-notification.png)
   <sub>A real OS notification on the iPad Simulator, sent by the server after the invitation was committed.</sub>

   ![The invitation card with Let's try and Later buttons](docs/images/ipad-invitation.png)
   <sub>The invitation in the iPad shell, opened from a notification tap (the shell's toolbar is cropped).</sub>

2. **Asks how, not just what.** The child jumps along a number line from 8 and answers 12 instead of 13. llime asks *"How did you get 12?"* The child explains aloud, or types. An account like "I started at eight and counted eight, nine, ten, eleven, twelve" supports the hypothesis that the child counted the starting number as a move.

   ![Number line from 0 to 15 for 8 + 5 with step buttons and Check my answer](docs/images/number-line.png)
   <sub>The number line with the film problem, rendered in a browser test, not taken from a live run.</sub>

3. **Uses comparable situations to choose how to explain.** llime searches other learners' recorded situations with a similar structure of actions and explanations, then compares the support they got and the independent results that followed. In the synthetic data, a ten-box ("make ten") activity leads. Codex composes the activity from validated components, so the child works with the same idea in a different form. The histories are authored to demonstrate the mechanism, not to show that one teaching method works better.

   ![Learning memory view: this student's history, the subtraction–addition curriculum link, today's lesson and a grid of 659 other learners' situations](docs/images/learning-memory-live.png)
   <sub>Live run (Codex App Server and Neo4j over the synthetic history): the learner's memory and today's lesson, before the search.</sub>

   ![Search and decision view: the child's attempt, observation and explanation on the left, the make-ten next step from 29 cases, and the three strategy groups 23/29, 14/22 and 3/8](docs/images/memory-search-decision.png)
   <sub>The search and decision, replayed from a recorded agent input over the synthetic cases (the view labels itself "Simulation").</sub>

4. **Checks a fresh attempt, then saves the evidence.** The child moves objects into a ten-box (8 + 5 becomes 10 + 3), then solves a fresh 9 + 4 with no hints and no microphone. The attempt, the explanation and the independent result are saved to the learner's memory graph. Reusing that saved case in a later session is future work.

   ![Make-ten activity for 8 + 5: ten apples in the box, two in the tray and one left over, with the equations 8 + 2 = 10 and 10 + 1 = ?](docs/images/make-ten-support.png)
   <sub>The make-ten support activity mid-move, rendered in a browser test, not taken from a live run.</sub>

## Why it matters

- **For the child:** an invitation they can accept or decline, followed by support built from their own attempt and explanation.
- **For the parent:** a record of whether a fresh problem was solved without hints. One attempt does not establish mastery, and whether this reduces homework rescues still needs testing.
- **Our design:** personal learning memory decides when the agent acts and how it explains. Guiding questions alone are not new; [Khanmigo](https://khanmigo.ai/) also guides learners without giving answers. Our claim is the integrated, inspectable loop: today's lesson, prior evidence, the learner's explanation and comparable cases lead to a concrete activity and a saved, independently checked outcome. Whether that beats simpler tutors is untested.

## Who it's for first

Parents of grade 2–3 children who keep needing help with math homework. The child is the user; parents are our first buyer hypothesis, with a subscription still to validate. Teachers can join later, but the family product does not depend on them.

## What the demo shows, honestly

- **Real execution:** nothing in the flow is scripted or hardcoded. Proven on a clean clone: the lesson save reaches the inbox watcher, a real Codex App Server turn calls the memory tool and publishes the invitation, and a real voice session opens and closes. In live QA runs, the hint-free check committed its outcome exactly once and the run completed. The filmed main run: TODO(run): main-run capture manifest path. Storybook stories and recorded fixtures are never used as evidence. Open failures are listed in [docs/engineering-qa.md](docs/engineering-qa.md).
- **Scripted:** the film uses problem seed 28, which gives 8 + 5 and then 9 + 4 (other seeds give other pairs). An adult plays the child and makes the planned mistake. The outcome rates in memory were written by us to show the mechanism.
- **Synthetic:** the lesson transcript and every learner history. Start and Stop recording on the Lesson notes screen stage the prepared transcript; no classroom audio is captured or transcribed. Finish lesson saves the transcript for real, and that saved file is what triggers processing. The memory holds 781 situations from 120 fictional learners.
- **Simulated:** the iPad runs in the iOS Simulator, and the notification is a simulated push.
- **Not shown:** real learning gains, long-term retention, a saved case being reused in a later session, or any real child data.
- **Not built:** a teacher view. The Lesson notes screen only saves the lesson transcript.
- **Engineering checks** outside the film are listed in [docs/engineering-qa.md](docs/engineering-qa.md).

## How it works

```mermaid
flowchart LR
  subgraph mac["Mac · every server bound to 127.0.0.1"]
    notes["Lesson notes page"] -->|save transcript| inbox["Run inbox file"]
    inbox -->|inbox watcher| server["llime server<br/>engine · five tools · store"]
    server <-->|"read · write in one transaction"| db[("Neo4j 5.26<br/>learning memory")]
    server <-->|"stdio JSON-RPC · tool calls"| codex["Codex App Server<br/>one child per run"]
    server -->|"outbox row"| push["xcrun simctl push"]
    views["Inspector · learning-memory view<br/>browser"] -->|"HTTP /api"| server
  end
  push --> ipad["iPad Simulator<br/>SwiftUI shell + WKWebView /student"]
  ipad <-->|"HTTP /api"| server
  ipad <-.->|"WebRTC audio"| live["GPT-Live"]
  server <-.->|"session create · sideband"| live
```

The main path, from the lesson to the saved result:

```mermaid
sequenceDiagram
  autonumber
  participant N as Lesson notes
  participant S as llime server
  participant C as Codex App Server
  participant D as Neo4j
  participant P as iPad (child)
  N->>S: Finish lesson saves the transcript to the run inbox
  S->>S: watcher commits WAITING → INGESTING
  S->>C: ingestion turn
  C->>S: get_personal_memory
  S->>D: read the learner's cases
  C->>S: publish_activity (invitation)
  S->>D: activity, event, receipt and outbox row in one transaction
  S->>P: simulated push notification
  P->>S: tap, then Let's try
  P->>S: first attempt 8 + 5 = 12
  S->>P: "How did you get 12?"
  P->>S: explanation (voice through GPT-Live, or typed)
  S->>C: explanation turn
  C->>S: search_learning_cases (the model's reading of the explanation)
  S->>D: commit the context graph, rank, decide: make ten
  C->>S: publish_activity (make-ten blocks)
  P->>S: support attempt, then hint-free 9 + 4 with voice off
  S->>C: verification turn
  C->>S: assess_attempt, then commit_episode
  S->>D: save the outcome as a new case
```

Each run moves through fixed phases ([`PHASE_TRANSITIONS`](src/domain.ts)):

```mermaid
stateDiagram-v2
  [*] --> WAITING
  WAITING --> INGESTING
  INGESTING --> INVITED
  INGESTING --> NO_MATCH
  INGESTING --> ERROR
  INVITED --> INITIAL
  INITIAL --> ALREADY_CORRECT
  INITIAL --> EXPLAIN
  INITIAL --> OUT_OF_SCOPE
  EXPLAIN --> PROCESSING
  PROCESSING --> PROCESSING: newer explanation revision
  PROCESSING --> CLARIFY
  PROCESSING --> PRACTICE
  PROCESSING --> NEEDS_SUPPORT: clarification cap
  PROCESSING --> ERROR
  CLARIFY --> PROCESSING
  PRACTICE --> PROCESSING: correction before submit
  PRACTICE --> VERIFY
  PRACTICE --> CLARIFY
  PRACTICE --> NEEDS_SUPPORT
  VERIFY --> COMPLETE
  VERIFY --> NEEDS_SUPPORT
  VERIFY --> ERROR
  NEEDS_SUPPORT --> EXPLAIN: continuation allowed
  NEEDS_SUPPORT --> PROCESSING: continuation allowed
  NO_MATCH --> [*]
  ALREADY_CORRECT --> [*]
  OUT_OF_SCOPE --> [*]
  COMPLETE --> [*]
  ERROR --> [*]
```

The model interprets; deterministic tools decide and write. Five tools search memory, compare situations, publish the activity, check the attempt and save the episode. The search compares the *structure* of situations (for example, a move trace one short of the answer followed by an explanation that counts the start) and never the child's words or the past outcome. Everything runs on one Mac, bound to `127.0.0.1`; model inference and voice are external services.

For the recorded film query, the search compares 659 other learners' cases on the same concept and admits 59 close matches. Among them, make-ten support has 23 independent successes in 29 assessed cases, marking the start 14 in 22, and repeating the count 3 in 8. Repeating the count has no activity template, so it can never be chosen. These numbers are recomputed from the seed by the build's own search code in [`tests/search-film.test.ts`](tests/search-film.test.ts). A live run depends on how the model reads the child's explanation: one live QA run ranked the same 659 cases and admitted 51. These are authored synthetic outcomes that drive a deterministic choice, not causal evidence about teaching methods.

Every tool call is visible in the inspector:

![Codex execution inspector showing the input, runtime boundary, get_personal_memory and publish_activity calls with their results, and the published invitation](docs/images/inspector-fixture.png)
<sub>The inspector with a story fixture, labelled "Fixture" in the view; it is not a recording of a run.</sub>

Details: [docs/architecture.md](docs/architecture.md).

## Run it

**Requirements:** macOS, Node.js ≥ 22.12, Docker (Docker Desktop or OrbStack), Codex CLI 0.166.0 signed in (`codex login`), an OpenAI API key for voice, and Xcode with the iOS 26.5 Simulator runtime for the iPad app.

The provider key is read from `~/.config/llime/provider.env` (a single `OPENAI_API_KEY=...` line, file mode 0600). The setup script copies it into the gitignored `.env` without printing it. Codex uses its own sign-in, and neither the key nor the database password is passed to it.

```sh
git clone https://github.com/victor0225/LLiMe.git && cd LLiMe
npm ci
node scripts/setup-env.mjs --init-machine   # once per computer: creates the local database credential
npm run setup:env                           # writes .env (0600) from the machine credential and key
npm run db:up                               # Neo4j 5.26 on 127.0.0.1:17474 / 17687
npm run doctor                              # checks Node, Docker, Neo4j, Codex, key, ports, data, Simulator
npm run dataset                             # checks the data files against their manifest
npm run seed                                # verifies the seed hash, loads 781 cases from 120 learners
npm run typecheck && npm test
```

Start the app and create a run:

```sh
npm run dev                                 # http://127.0.0.1:4317
npm run demo:reset -- --case main           # prints the new RUN_ID (film seed unless --seed N)
```

Open `http://127.0.0.1:4317/lesson-notes?runId=RUN_ID` and press Start recording, Stop recording, then Finish lesson. Or, from a terminal, `npm run demo:drop -- --run RUN_ID` writes the same prepared transcript into the run's inbox. Either way, the inbox watcher starts ingestion.

| Page | What it shows |
| --- | --- |
| `/student?runId=RUN_ID` | The child's app: invitation, number line, explanation, activity, independent check |
| `/inspector?runId=RUN_ID` | Every tool call with its arguments, result and timing |
| `/backend?runId=RUN_ID` | The learning-memory search and the decision |

**iPad app:** build and install the Simulator shell as described in [ios/README.md](ios/README.md), and launch it with `-LLIME_ORIGIN http://127.0.0.1:4317`, the server's address. To receive the simulated notification, set `SIMULATOR_UDID` in `.env` to the booted device's UDID before starting the server.

**Recording and evidence:**

```sh
npm run build && npm run start              # serves the built app from dist/
npm run demo:export -- --run RUN_ID         # read-only capture under .runtime/captures/
npm run demo:replay -- --capture CAPTURE_ID # opens a capture read-only
npm run live:voice                          # opens and closes one voice session as a check
```

**Stop and clean up:** Ctrl-C stops `dev` or `start`. With the server stopped, `npm run demo:purge -- --run RUN_ID` deletes that one run's data and nothing else. The database keeps running and keeps its volume.

A clean `https` clone ran this sequence, from `npm ci` through `demo:purge` and `npm run build-storybook`, and every step exited 0. It ran on a build Mac that already had the database credential, the running Neo4j service, Docker images and npm caches, so it is not a bare-machine install: `--init-machine`, a cold first start of Neo4j and the Simulator steps were not exercised, and `demo:replay` was not part of it. On npm 11, `npm ci` warns that the esbuild and fsevents install scripts are not allowlisted; build and tests are unaffected.

## Where this goes

Grade 2–3 math is the first loop, not the limit. The same memory should follow a learner across grades, subjects and teachers. It should be updated by new evidence rather than harden into labels, and it should stay under the learner's control.

## What we still need to learn

- Whether this improves independent and delayed performance compared with simpler tutors.
- Whether invitations feel timely rather than disruptive.
- Whether other learners' outcomes add value beyond the child's own record.
- Whether choosing help from past choices narrows what gets tried. The current rule does not explore, and past outcomes reflect earlier choices, not proof of what works.
- Whether parents come back and pay.

## Team

**Team Zook**

- **Sunho Kim:** Denison University; software engineer at Wondermove; founder of FlowSpace ([myflowspace.app](https://myflowspace.app))
- **Suhyun Cho:** Tech University of Korea

## Data and license

**Data:** the learner cases and lesson transcript are authored synthetic data. Each ships with a manifest and SHA-256 hash ([`data/seed/manifest.json`](data/seed/manifest.json), [`data/lesson/manifest.json`](data/lesson/manifest.json)) that `npm run seed` and `npm run doctor` check.

**License:** no license yet.

**Product and pitch review.** We used [gstack](https://github.com/garrytan/gstack)'s Office Hours diagnostic and CEO review questions to challenge the product framing, compare one-liners and review the 90-second demo with an independent AI reviewer. This shaped planning and presentation. It is not a runtime dependency, an official YC evaluation or evidence of customer demand.
