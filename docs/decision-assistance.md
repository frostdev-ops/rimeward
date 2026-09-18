# Decision assistance (experimental)

Optional help from a decision model — TypeSafe's Jev, reached through OpenRouter's
`POST https://openrouter.ai/api/alpha/decisions` — for the places where Rimeward already
makes a yes/no or pick-one judgment. Jev answers typed questions over supplied state:
`noul` (a probability for a proposition), `choice` (one of the supplied keys), `score`
(a position on ordered levels). It writes no prose, no code and no tool arguments.

Everything here is **off until the user turns it on**, one switch per feature. An
OpenRouter key alone enables nothing. With every switch off the code path makes no
decision request, starts no timer, adds no prompt text and changes no model choice.

## What each switch sends and does

All switches live on the agent ward's **⚙ Configure → Decision assistance**, except
the Leyline ones, which are a per-node `judge` choice. Each sends only the context named
below to OpenRouter on the user's own OpenRouter key; a paired desktop without a key of
its own asks its server through `/api/agent/decisions` (the key never leaves the server).

| Switch | Where | Sends | Does |
|---|---|---|---|
| Monitor decisions: `off` / `observe` / `filter` | ward | the monitored text field (tail, 6 000 chars), the source type | The ceiling for a monitor's `decision` argument (`monitor` tool). `observe` records the verdict on the monitor's status for inspection while delivery stays exactly as before. `filter` lets a monitor deliver only on a match and blocks visibly when the decision is unavailable. |
| Leyline `judge: jev` on **Rime says yes to** | node | the rendered question | One `noul`; the condition passes at or above 0.5 (the boolean reading of a probability). Unavailable = an error run, never a silent no. Default `chat` keeps today's chat-model path. |
| Leyline `judge: jev` on **Sort this packet** | node | the packet text, the channel ids and descriptions | One `choice` over exactly the listed ids; an off-list answer is an error run and the packet stays put. The receipt is the channel's own description plus the returned probability — Jev cannot write a reason, and none is invented. |
| Completion advice | ward | the recent user text, the final reply, this turn's tool record (tool, kind, reason, ok/error) | Before a final no-tool answer is accepted, asks whether the record evidences completion and what the next step is. A `verify`/`change_approach` with completion evidence below 0.5 earns **one** extra round inside the existing caps, with a note that says it is an application check, not a verification and not new authority. Skipped when no tool ran, when one of the turn's background tasks is still live (that is "wait", known without inference), on monitor wakes, and after a Stop. |
| Rank tool search results | ward | the query, the names and descriptions of the already-permitted candidates | Reorders `search_tools` results only. Exact-name matches stay first; nothing is added, dropped, loaded, unloaded or hidden from the catalog. |
| Rank retrieved knowledge | ward | the query, the retrieved hits' source ids, titles and excerpts | Reorders the hits `search_knowledge` and the per-turn memory passages already retrieved. Same hits, same identities, same text. |
| Automatic model routing (candidate list) | ward | the recent user text | One pick per run at admission, among the listed candidates only, each validated by the catalog like a `set_model`, on the ward's own provider/backend. A `score` of the request's demand indexes the list (smallest first). Unsure, invalid or failed = the configured model. Recorded as a note; `set_model` and the footer pickers still override it. |

## Monitor gate, precisely

A monitor's `decision` is `{ mode, field, propositions, combine?, threshold }`:

- `propositions`: 1–4 independent factual yes/no statements, each answered separately
  against the same text and combined in code with `combine` (`any`, the default, or `all`).
  There is deliberately no second broad "should this wake?" question — the experiments
  showed such a question can contradict the facts it summarises.
- `threshold`: the probability floor a proposition must reach, 0.5–0.99, required. It is a
  probability, unrelated to the embedding gate's cosine `threshold`, and it is not
  validated for any source: choose it deliberately. Below the floor is simply "no match"
  and the verdict stays inspectable on the monitor status (`lastDecision`).
- Order: baseline, duplicate key, exact filter, embedding gate (if any), decision gate.
  Nothing rejected earlier is ever sent.
- `filter` mode keeps the pending candidate and blocks with a visible error when the
  decision is unavailable or malformed, exactly as the embedding gate does; the ordinary
  30 s candidate retry applies. Switching the ward to `off` or `observe` while a `filter`
  monitor exists blocks it with a message rather than delivering unfiltered.
- The ward switch is re-read after every await: a result arriving after the switch, the
  owner, the source revision or the monitor revision changed is dropped.
- A match is a delivery like any other: the woken turn stays read-only, and the verdict
  never appears in the notice text.

For terminal status the tool description offers the three propositions the experiments
settled on (an actual input request, an unresolved failure, explicit success).

## What Jev may never do

No answer, probability or confidence widens permissions. Approvals, argument validation,
backend pinning, ownership checks, confirm handling and read-only monitor turns are
untouched. The experiments recorded a draft-only request judged as authorizing a send
(0.82); that is why no "tool-risk" feature exists here.

## Diagnostics and failure

Every call lands in the account's bounded model-call record (`agent_model_calls`) with
`purpose`, requested and actual model ids, timing, usage and cost when reported (unknown
stays unknown), and outcome; failures also land in `agent_diagnostics` with a category.
Never the state, the questions' subjects or a credential. Each feature keeps its own
failure behaviour above; there is no global allow-on-error or block-on-error.

`confidence` on a `choice`/`score` answer summarises the returned distribution. It is
shown only where the code uses it (routing) and is not a measured probability of
correctness. Nothing here is a calibration or accuracy claim: the September 2026
experiments were short synthetic cases, and their two prompt failures (a quoted
`Allow this command?` read as a live prompt; a draft-only send judged authorized) are the
reason for the untrusted-data guard on every question and for keeping authorization out.
