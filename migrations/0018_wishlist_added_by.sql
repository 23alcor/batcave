-- NULL preserves unknown authorship for items saved before contributor tracking.
ALTER TABLE wishlist ADD COLUMN added_by INTEGER;
