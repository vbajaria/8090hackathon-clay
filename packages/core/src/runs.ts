import {
  IdSchema,
  RunProgressSchema,
  RunResultSchema,
} from "@leadwork/contracts";
import { Database, fail } from "./db.js";
import { workspace, ownedTable, inputSignature, columnDto } from "./tables.js";
import { finalizeRuns } from "./planner.js";
export class RunService {
  constructor(readonly db: Database) {}
  async list(owner: string, tableId?: string) {
    return this.db.transaction(async (tx) => {
      const ws = await workspace(tx, owner);
      if (tableId) await ownedTable(tx, ws, tableId);
      const runs = (
        await tx.query(
          `SELECT * FROM app.runs WHERE workspace_id=$1${tableId ? " AND table_id=$2" : ""} ORDER BY created_at DESC,id LIMIT 100`,
          [ws, ...(tableId ? [tableId] : [])],
        )
      ).rows;
      const result = [];
      for (const run of runs) {
        const steps = (
          await tx.query(
            "SELECT outcome,COUNT(*)::int AS count FROM app.steps WHERE run_id=$1 GROUP BY outcome",
            [run.id],
          )
        ).rows;
        result.push(progress(run, steps));
      }
      return result;
    });
  }
  async detail(owner: string, id: string, cursor?: string, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 250)
      fail("invalid_value");
    let after: any;
    if (cursor) {
      try {
        after = JSON.parse(Buffer.from(cursor, "base64url").toString());
      } catch {
        fail("invalid_value");
      }
      if (after.runId !== id) fail("invalid_value");
      IdSchema.parse(after.rowId);
      IdSchema.parse(after.stepId);
    }
    return this.db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const ws = await workspace(tx, owner);
      const run = (
        await tx.query(
          "SELECT * FROM app.runs WHERE id=$1 AND workspace_id=$2",
          [id, ws],
        )
      ).rows[0];
      if (!run) fail("not_found");
      const steps = (
        await tx.query(
          `SELECT s.*,c.stale FROM app.steps s LEFT JOIN app.cells c ON c.row_id=s.row_id AND c.column_id=s.column_id WHERE s.run_id=$1${after ? " AND (s.row_id,s.id)>($3::uuid,$4::uuid)" : ""} ORDER BY s.row_id,s.id LIMIT $2`,
          [id, limit + 1, ...(after ? [after.rowId, after.stepId] : [])],
        )
      ).rows;
      const hasMore = steps.length > limit;
      steps.splice(limit);
      const counts = (
        await tx.query(
          "SELECT outcome,COUNT(*)::int AS count FROM app.steps WHERE run_id=$1 GROUP BY outcome",
          [id],
        )
      ).rows;
      const attempts = (
        await tx.query(
          "SELECT a.* FROM app.attempts a WHERE a.step_id=ANY($1::uuid[]) ORDER BY a.created_at,a.position,a.id",
          [steps.map((s) => s.id)],
        )
      ).rows;
      const columns = (
        await tx.query("SELECT * FROM app.columns WHERE table_id=$1", [
          run.table_id,
        ])
      ).rows.map(columnDto);
      const rowIds = [...new Set(steps.map((s) => s.row_id))];
      const liveCells = (
        await tx.query(
          "SELECT row_id,column_id,value,version FROM app.cells WHERE table_id=$1 AND row_id=ANY($2::uuid[])",
          [run.table_id, rowIds],
        )
      ).rows;
      const results = steps.map((s) => {
        const row = liveCells.filter((c) => c.row_id === s.row_id);
        const currentSignature = inputSignature(
          columns,
          s.column_id,
          Object.fromEntries(row.map((c) => [c.column_id, c.value])),
          Object.fromEntries(row.map((c) => [c.column_id, String(c.version)])),
        );
        const reasons = new Set([
          "fresh_output",
          "fresh_reuse",
          "no_match",
          "missing_input",
          "dependency_unavailable",
          "provider_error",
          "uncertain_outcome",
          "canceled_before_dispatch",
        ]);
        return {
          ...RunResultSchema.parse({
            stepId: s.id,
            runId: id,
            rowId: s.row_id,
            columnId: s.column_id,
            outcome: s.outcome,
            storedValue: s.result,
            stale:
              (s.stale ?? true) ||
              (!!s.result && !s.input_fingerprint) ||
              (!!s.input_fingerprint &&
                s.input_fingerprint !== currentSignature),
            explanation:
              s.outcome === "reused"
                ? "fresh_reuse"
                : reasons.has(s.reason)
                  ? s.reason
                  : s.reason
                    ? "missing_input"
                    : null,
            provenance: s.provenance,
          }),
          ...(s.outcome === "reused"
            ? {
                sourceResultId:
                  s.source_step_id ??
                  `snapshot:${id}:${s.row_id}:${s.column_id}`,
              }
            : {}),
        };
      });
      return {
        progress: progress(run, counts),
        nextCursor: hasMore
          ? Buffer.from(
              JSON.stringify({
                runId: id,
                rowId: steps.at(-1)!.row_id,
                stepId: steps.at(-1)!.id,
              }),
            ).toString("base64url")
          : null,
        results,
        attempts: attempts.map((a) => ({
          id: a.id,
          executionStepId: a.step_id,
          connection: {
            id: a.connection_id,
            revision: String(a.connection_revision),
          },
          waterfallPosition: a.position,
          dispatchState: a.dispatch_state,
          requestId: a.request_id,
          task: a.task,
          deadlineAt: new Date(a.deadline_at).toISOString(),
          outcome: a.outcome,
          createdAt: new Date(a.created_at).toISOString(),
        })),
      };
    });
  }
  async cancel(owner: string, id: string) {
    return this.db.transaction(async (tx) => {
      const ws = await workspace(tx, owner),
        initial = (
          await tx.query(
            "SELECT * FROM app.runs WHERE id=$1 AND workspace_id=$2",
            [id, ws],
          )
        ).rows[0];
      if (!initial) fail("not_found");
      await ownedTable(tx, ws, initial.table_id, true);
      const run = (
        await tx.query(
          "SELECT * FROM app.runs WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
          [id, ws],
        )
      ).rows[0];
      if (["completed", "canceled"].includes(run.status))
        return { id, status: run.status };
      await tx.query(
        "UPDATE app.runs SET status='cancel_requested' WHERE id=$1",
        [id],
      );
      const queued = (
        await tx.query(
          "UPDATE app.steps SET outcome='canceled',reason='canceled_before_dispatch' WHERE run_id=$1 AND outcome='queued' RETURNING id,row_id,column_id",
          [id],
        )
      ).rows;
      for (const s of queued) {
        await tx.query("DELETE FROM app.reservations WHERE step_id=$1", [s.id]);
        await tx.query(
          "UPDATE app.cells SET outcome='canceled',stale=true WHERE row_id=$1 AND column_id=$2",
          [s.row_id, s.column_id],
        );
      }
      await finalizeRuns(tx, id);
      return {
        id,
        status: (
          await tx.query("SELECT status FROM app.runs WHERE id=$1", [id])
        ).rows[0].status,
      };
    });
  }
}
function progress(run: any, steps: any[]) {
  const counts = {
    queued: 0,
    running: 0,
    succeeded: 0,
    reused: 0,
    no_result: 0,
    failed: 0,
    skipped: 0,
    canceled: 0,
    unknown: 0,
  };
  for (const s of steps)
    counts[s.outcome as keyof typeof counts] += s.count ?? 1;
  return {
    ...RunProgressSchema.parse({
      id: run.id,
      tableId: run.table_id,
      parentRunId: run.parent_run_id,
      status: run.status,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      terminal:
        Object.values(counts).reduce((a, b) => a + b, 0) -
        counts.queued -
        counts.running,
      counts,
    }),
    createdAt: new Date(run.created_at).toISOString(),
    completedAt: run.completed_at
      ? new Date(run.completed_at).toISOString()
      : null,
  };
}
