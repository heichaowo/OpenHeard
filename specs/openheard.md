# OpenHeard — Spec

Only what constrains the code. Anything that would still be true if the code
changed belongs elsewhere: site data in configuration, evaluation and operator
context in the author's notes, procedures in the README.

## What this is

A QSO logbook fed by machine-readable sources rather than by typing. Digital
networks publish per-session feeds. Analog repeaters publish nothing, so a
receive-only receiver turns squelch openings into events. A human supplies only
what no machine can know.

## The requirement

Log every contact automatically, analog and digital, across whatever repeater
or network carried it.

One property drives everything else. Automation comes from whoever kept a
record, never from the radio.

## Fixed decisions

Settled before any code, because changing them later is the expensive case.

**The data model carries every field LoTW requires, from the first migration.**
Frequency, mode, band, both RST directions, and the grid square. A schema that
already holds contacts is the worst thing to retrofit, and that flaw is what
ruled out building on an existing net-logging tool.

**It also carries QTH, device, antenna, power and height.** These cost nothing
to store and cannot be recovered after the contact.

**The web UI is React 19 with Ant Design 6.**

**There is no native client.** The capture daemon runs headless and nobody
types during a contact, so a browser suffices. Revisit only for a concrete
offline-in-the-field need, and try a PWA first.

**Nothing gets reinvented.** TQSL signs LoTW uploads through its command line.
DXCC resolution uses an existing cty.dat library. The web layer uses a standard
framework. What we write is the capture pipeline, the clustering, and the ADIF
assembly, because nobody has written those.

## What the system can promise

| How the contact was carried | What the machine can know |
|---|---|
| Analog FM through a repeater | when, how long, which channel, and whether we were in it |
| Analog FM, the far station's callsign | nothing |
| DMR through a network with a public feed | everything the feed carries |
| DMR on a network without a feed | nothing |
| HF, later | FT8 through the WSJT-X UDP feed, nothing for SSB |

The analog gap is permanent, not a missing feature. Analog FM carries no
identity, so no receiver and no software can name the far station. Speech
recognition narrows the gap and never closes it, which is why the system must
stay fully usable with it switched off.

## Shape

One always-on daemon captures and posts to the API. A browser talks to the
API. There is no third executable.

Analog capture treats a squelch opening as the transmission event. The receiver
covers a configured span of spectrum; how wide that span is and which channels
fall inside it are deployment configuration, not design.

Digital capture polls rather than subscribes wherever the feed supports a
history query, because a missed poll then heals itself while a dropped
subscription loses events permanently.

## Grouping transmissions into contacts

Gap-based clustering splits the event stream into conversations. The threshold
comes from measurement against real traffic, never from a guess.

Deciding which conversations were ours needs a marker the radio transmits.
MDC-1200 carries a unit ID in one short burst and does not collide with
repeater control codes. DTMF is rejected: its tones sound on every over, and a
badly chosen string transmits repeater commands.

Repeater hang time merges fast exchanges into a single long event, and it
merges worst exactly when the channel is busiest. Clustering therefore degrades
precisely where the marker is needed most, so the two are not alternatives.

Durations run long by roughly the hang time. Very short events come from weak
signals briefly opening squelch, which is a threshold question.

## Speech recognition, optional

Two stages that can be enabled separately. A provider transcribes one already
segmented transmission. A text model then extracts candidate fields.

The extraction contract: return one JSON object, omit any field not clearly
spoken, never infer, return an empty object for noise, decode NATO phonetics
into an uppercase callsign, and normalise spoken power to digits plus W.

Every candidate needs human confirmation before it reaches the log. The model
is configuration and is never a hard-coded name.

## RST

Do not derive signal strength for a repeater contact. The receiver hears the
repeater's downlink, and a repeater retransmits at constant power, so the
measured level describes the repeater and our own antenna. It is identical for
every station on that repeater.

Readability inverts this. A repeater passes the far station's uplink noise
through, so a weak station sounds noisy at full RF power. Audio SNR therefore
carries the correspondent's path quality when RF level does not.

Derive both on simplex. On a repeater derive R from audio SNR if it proves
stable, otherwise default to 59.

## Rejected

**Building on a net-logging tool.** Its model is built for roll-call: no
frequency, mode or band, no ADIF, and a main-control callsign with no
counterpart here. Its licence also reaches a publicly deployed service.

**Building on an existing web logbook.** Nothing would need changing, so a fork
would add merge burden and nothing else. It stays a reference and a fallback.

**Desktop loggers as a base.** They centre on CAT control of a transceiver and
expose no external write API, so nothing can push captured records in.

**Speech recognition as a requirement.** It is an accelerator. The system must
work with it off.

## Open

- Licence. MIT or Apache-2.0. AGPL is ruled out because it deters adoption by a
  club, which is a goal.
- Backend language and framework.
- Whether the ASR stage runs inside the daemon or as its own service.
