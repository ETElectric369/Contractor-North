# Parked: ET Electric's derivation chain (2026-08-08)

Erik rewrote the first four questions of his own playbook and the shape that came out is the
estimate itself:

1. **Service call or job**
2. **Scope** — "What is the job?" — free text
3. **Materials** — "What materials are needed?" → *"Line items listed individually on estimate priced from price book"*
4. **Man hours** — "How long will it take?" → *"Labor line item(s)"*

Materials plus labor is an estimate. Nothing else on the sheet produces money.

## Why these seven were parked

Two reasons, and the second is his.

**They were unreachable.** Every one gated on `work` being one of a fixed option list
(`Add circuits`, `Lighting`, `Remodel / rough-in`…). Scope is free text now, so those clauses
could never match again — verified against the real resolver: eight questions returned
"NOT REACHABLE" on every scenario.

**And the gate was the wrong idea anyway.** Erik: *"honestly it makes those gated questions a wall
to everything else i could possibly say in the scope."* A gate keyed to an option list silently
caps what the scope is allowed to BE. Anything he says that isn't on the list gets nothing.

**They derive what he now states directly.** The test was his own why lines — does a question
CHANGE materials/hours, or COMPUTE them? These compute:

| Parked | Its why line | Why it's redundant now |
|---|---|---|
| `run_ft` | "Times the wire cost per foot, plus the conduit" | computes a material quantity he types |
| `length_ft` | "Wall feet divided by 6 gives the outlet count under 210.52(A)" | computes a device count he types |
| `width_ft` | "With the length this gives square footage, which sizes the lighting" | same chain |
| `ceiling_ft` | "Drives can spacing and whether I'm on a ladder or a lift" | folds into hours, which he states |
| `device_count` | "Times the per-outlet price" | the thing the chain existed to produce |
| `wiring_method` | "It's what the walls and the permit add up to" | a conclusion, and its rule was broken (see below) |
| `materials_known` | "Goes straight to the takeoff" | **duplicate** of his new Materials question |

## What stayed, and why

The four that CHANGE materials or hours rather than computing them — quoting his own lines:

- **Feed** — *"everything about wire and labor is downstream of it"*
- **Walls** — *"roughly doubles the labor on its own"*
- **Panel** — *"turns a $400 circuit into a panel swap"*
- **Access** — *"that IS the labor"*

All four now gate on `work_kind = Contract job`. A service call is four questions total; his own
definition is *"troubleshooting and/or an emergency call, find out what's wrong and fix it"* — the
diagnosis IS the scope, so nothing upstream of it applies.

## The key-reuse landmine, recorded

He repurposed two questions by editing their label/ask/why. The KEYS underneath did not change and
are invisible in the editor:

- `permitted` is now **Materials**
- `gotcha` is now **Man hours**

That bit exactly once: `wiring_method` was gated on *"walls answered AND permitted answered"*, which
after the rename read *"and Materials answered"* — a rule he never wrote. It left with
`wiring_method`. The keys are deliberately NOT renamed: answers are stored keyed, and renaming would
orphan anything already captured under the old names for no visible gain.

**The editor lesson:** you can rename a question but not its key, so a repurposed question keeps its
old identity and any rule pointing at it silently changes meaning. Worth surfacing in the editor.

## Getting them back

They are in git and in `PLAYBOOK_STARTERS['et-electric']`, unchanged. If the room-to-outlet-count
arithmetic is ever wanted again, it should come back as something **Nort computes** from the scope
and hands him — not as six questions he answers on a tailgate.
