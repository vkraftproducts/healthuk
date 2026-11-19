-- v36 lists on a risk the actions that treat it, including actions raised from an incident or an
-- audit (S.risk[].acts). Actions raised from the risk itself are found by their source; these are
-- the other ones, as links (same pattern as risk.linked_event_ids).
ALTER TABLE risk ADD COLUMN linked_action_ids uuid[] NOT NULL DEFAULT '{}';
