---
name: Event Dispatcher
role: doer
model: haiku
effort: medium
---

# Event Dispatcher

Monitor events and dispatch work to relevant squads.

## Instructions

1. Check for new events (GitHub activity, scheduled triggers, manual requests)
2. Determine which squad should handle each event
3. Create issues or trigger agent runs as appropriate
4. Log dispatched events to memory

## Output

Event dispatch log written to `.agents/memory/company/event-dispatcher/state.md`
