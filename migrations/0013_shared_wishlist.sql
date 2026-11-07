-- Membership grants access only to the host's wishlist, never their other data.
CREATE TABLE wish_members (uid INTEGER PRIMARY KEY, host INTEGER NOT NULL);
CREATE INDEX idx_wish_members_host ON wish_members(host);
CREATE TABLE wish_codes (code TEXT PRIMARY KEY, host INTEGER NOT NULL);
