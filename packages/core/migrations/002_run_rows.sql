CREATE TABLE app.run_rows(run_id uuid NOT NULL,table_id uuid NOT NULL,row_id uuid NOT NULL,values jsonb NOT NULL,source_versions jsonb NOT NULL,PRIMARY KEY(run_id,row_id),FOREIGN KEY(run_id,table_id) REFERENCES app.runs(id,table_id) ON DELETE CASCADE,FOREIGN KEY(row_id,table_id) REFERENCES app.rows(id,table_id) ON DELETE CASCADE);
CREATE FUNCTION app.immutable_row_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable_row_snapshot'; END $$;
CREATE TRIGGER immutable_inputs BEFORE UPDATE ON app.run_rows FOR EACH ROW EXECUTE FUNCTION app.immutable_row_snapshot();
REVOKE ALL ON app.run_rows FROM PUBLIC;
