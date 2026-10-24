# Herdsman

Herdsman coordinates bounded assignments to workers and their completion lifecycle.

## Language

**Worker**:
An agent with a retained session and a history of assignments. A worker remains the same worker when its process is replaced.

**Subject**:
Radar's durable identity for an agent, independent of whether that agent currently has a running process.
_Avoid_: Registration, pane

**Assignment**:
One bounded piece of work accepted by a worker, with its own completion obligation.

**Continue**:
Give a retained worker a new assignment using its existing session. If its process has stopped, Radar starts that same worker again by its subject.
_Avoid_: Resume by path

**Restart**:
Replace a worker's process while retaining its subject, session and held assignment. A restart is not a new assignment or a close followed by continuation.

**Retire**:
Resolve the worker's current assignment as non-reusable. Retirement does not erase the worker's retained subject, session or completion report.

**Completion**:
The worker's sealed outcome for an assignment, awaiting deliberate consumption and lifecycle resolution by its owner. Delivering a preview does not consume it or release the worker for new work.
