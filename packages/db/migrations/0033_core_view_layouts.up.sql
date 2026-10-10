-- migrate:phase expand
-- Phase 3B (0B ADR-28, 0C AZ-28, 0D PL-30): the core view layouts. A saved view's layout chooses how the
-- canonical 3A query result is rendered; every layout reads the same authorized record set, so
-- no layout carries its own filtering, sorting, grouping, or authorization rules.
ALTER TABLE views.saved_view DROP CONSTRAINT saved_view_layout_known;
ALTER TABLE views.saved_view ADD CONSTRAINT saved_view_layout_known CHECK (layout IN (
  'list', 'board', 'table', 'calendar', 'timeline', 'gantt', 'workload', 'milestones', 'portfolio',
  'activity', 'timesheet'));
-- Project-only and task-only layouts (the entity decides which renderings exist).
ALTER TABLE views.saved_view ADD CONSTRAINT saved_view_layout_entity CHECK (
  (entity = 'task' AND layout IN ('list', 'board', 'table', 'calendar', 'timeline', 'gantt', 'workload',
    'activity', 'timesheet'))
  OR (entity = 'project' AND layout IN ('list', 'board', 'table', 'calendar', 'timeline', 'gantt',
    'milestones', 'portfolio', 'activity')));
