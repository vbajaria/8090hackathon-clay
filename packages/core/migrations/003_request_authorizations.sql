CREATE TABLE app.request_authorizations(id uuid PRIMARY KEY,attempt_id uuid NOT NULL REFERENCES app.attempts(id) ON DELETE CASCADE,position int NOT NULL CHECK(position>=0),authorized_at timestamptz NOT NULL DEFAULT now(),UNIQUE(attempt_id,position));
CREATE INDEX request_authorization_time ON app.request_authorizations(authorized_at);
REVOKE ALL ON app.request_authorizations FROM PUBLIC;
