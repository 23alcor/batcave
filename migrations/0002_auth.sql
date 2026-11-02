-- Failed password attempts, used to lock an IP out for 15 minutes after repeated wrong passwords.
CREATE TABLE IF NOT EXISTS auth_failures (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_failures_ip_at ON auth_failures (ip, at);
