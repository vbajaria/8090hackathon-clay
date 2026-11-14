ALTER TABLE app.steps ADD COLUMN input_fingerprint text CHECK(input_fingerprint IS NULL OR input_fingerprint ~ '^[a-f0-9]{64}$');
CREATE UNIQUE INDEX run_cell_step ON app.steps(run_id,row_id,column_id);
