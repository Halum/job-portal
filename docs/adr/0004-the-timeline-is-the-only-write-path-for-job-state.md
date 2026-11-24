# The Timeline is the only write path for Job state

Every discovery state and application status change goes through the Tracker as a Timeline event (from, to, actor, evidence, time) that takes the Job row lock and stores the furthest stage before it. This makes every change auditable by actor (user, skill, gmail, system) and lets undo restore the furthest stage, the only backward move. Undo reverts only the last state-changing event and a second undo in a row is refused.
