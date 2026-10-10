-- Reverts 0033 (local/test only). Restores the exact 0032 catalog.
ALTER TABLE views.saved_view DROP CONSTRAINT saved_view_layout_entity;
ALTER TABLE views.saved_view DROP CONSTRAINT saved_view_layout_known;
ALTER TABLE views.saved_view ADD CONSTRAINT saved_view_layout_known CHECK (layout IN ('list'));
