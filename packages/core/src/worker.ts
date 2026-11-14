import {
  createGateway,
  decryptCredentials,
  type ProviderEnvelope,
  type Credentials,
} from "@leadwork/providers";
import {
  ProviderRequestSchema,
  type Column,
  type CellValue,
  type ProviderRequest,
} from "@leadwork/contracts";
import {
  evaluateFormula,
  resolveInstructions,
  columnDependencies,
} from "@leadwork/engine";
import { Database, type Tx } from "./db.js";
import {
  loadTable,
  ownedTable,
  uid,
  staleDependents,
  touch,
  nullValue,
  recalculate,
  inputSignature,
} from "./tables.js";
import { finalizeRuns, inputIssue, inputText, refs } from "./planner.js";
import { recordObservationTx } from "./ledger.js";
import type { Policy } from "./connections.js";
const active = ["queued", "running"];
const terminalSuccess = ["succeeded", "reused"];
export class Worker {
  constructor(
    readonly db: Database,
    readonly key: string,
    readonly gateway: ReturnType<typeof createGateway>,
    readonly policies: readonly Policy[],
    readonly leaseMs = 180_000,
  ) {}
  async recover() {
    return this.db.transaction(async (tx) => {
      const expired = (
        await tx.query(
          "SELECT s.id,r.table_id,r.workspace_id,r.id AS run_id FROM app.steps s JOIN app.runs r ON r.id=s.run_id WHERE s.outcome='running' AND s.lease_until<now() ORDER BY r.table_id,s.id LIMIT 100",
        )
      ).rows;
      for (const x of expired) {
        await ownedTable(tx, x.workspace_id, x.table_id, true);
        await tx.query("SELECT id FROM app.runs WHERE id=$1 FOR UPDATE", [
          x.run_id,
        ]);
        const s = (
          await tx.query(
            "SELECT * FROM app.steps WHERE id=$1 AND outcome='running' AND lease_until<now() FOR UPDATE SKIP LOCKED",
            [x.id],
          )
        ).rows[0];
        if (!s) continue;
        const dispatched = (
          await tx.query(
            "SELECT 1 FROM app.attempts WHERE step_id=$1 AND dispatch_state<>'prepared'",
            [s.id],
          )
        ).rowCount;
        if (!dispatched) {
          await tx.query(
            "UPDATE app.steps SET outcome='queued',fencing=fencing+1,lease_until=NULL WHERE id=$1",
            [s.id],
          );
        } else {
          await tx.query(
            "UPDATE app.steps SET outcome='unknown',reason='uncertain_outcome',fencing=fencing+1,lease_until=NULL WHERE id=$1",
            [s.id],
          );
          await tx.query(
            "UPDATE app.attempts SET dispatch_state='unknown',outcome='unknown' WHERE step_id=$1 AND dispatch_state IN('dispatch_intent','awaiting_result')",
            [s.id],
          );
          await tx.query(
            "UPDATE app.cells SET outcome='unknown',stale=true WHERE row_id=$1 AND column_id=$2",
            [s.row_id, s.column_id],
          );
          await tx.query("DELETE FROM app.reservations WHERE step_id=$1", [
            s.id,
          ]);
        }
        await finalizeRuns(tx, x.run_id);
      }
      await tx.query(
        "DELETE FROM app.plans WHERE expires_at<now() AND committed_result IS NULL",
      );
      return expired.length;
    });
  }
  async claim() {
    return this.db.transaction(async (tx) => {
      const candidate = (
        await tx.query(
          `SELECT s.id,r.id AS run_id,r.table_id,r.workspace_id FROM app.steps s JOIN app.runs r ON r.id=s.run_id WHERE s.outcome='queued' AND r.status IN('queued','running') AND NOT EXISTS(SELECT 1 FROM app.steps dep WHERE dep.id=ANY(s.prerequisite_ids) AND dep.outcome IN('queued','running')) ORDER BY r.created_at,s.id LIMIT 1`,
        )
      ).rows[0];
      if (!candidate) return null;
      await ownedTable(tx, candidate.workspace_id, candidate.table_id, true);
      const run = (
        await tx.query("SELECT * FROM app.runs WHERE id=$1 FOR UPDATE", [
          candidate.run_id,
        ])
      ).rows[0];
      if (!run || !["queued", "running"].includes(run.status)) return null;
      const s = (
        await tx.query(
          "SELECT * FROM app.steps WHERE id=$1 AND outcome='queued' FOR UPDATE SKIP LOCKED",
          [candidate.id],
        )
      ).rows[0];
      if (!s) return null;
      const deps = (
        await tx.query("SELECT * FROM app.steps WHERE id=ANY($1::uuid[])", [
          s.prerequisite_ids,
        ])
      ).rows;
      if (deps.some((d) => active.includes(d.outcome))) return null;
      const frozen = (
        await tx.query(
          "SELECT * FROM app.run_rows WHERE run_id=$1 AND row_id=$2",
          [run.id, s.row_id],
        )
      ).rows[0];
      const values: Record<string, CellValue> = { ...frozen.values };
      for (const d of deps)
        if (terminalSuccess.includes(d.outcome) && d.result)
          values[d.column_id] = d.result;
      const col: Column = run.snapshot.columns.find(
        (c: Column) => c.id === s.column_id,
      );
      if (deps.some((d) => !terminalSuccess.includes(d.outcome))) {
        await this.finishTx(
          tx,
          s,
          run,
          "skipped",
          null,
          "dependency_unavailable",
          null,
        );
        return null;
      }
      const inputFingerprint = inputSignature(
        run.snapshot.columns,
        s.column_id,
        values,
        frozen.source_versions,
      );
      await tx.query(
        "UPDATE app.steps SET outcome='running',fencing=fencing+1,lease_until=now()+($2::int * interval '1 millisecond'),input_fingerprint=$3 WHERE id=$1",
        [s.id, this.leaseMs, inputFingerprint],
      );
      await tx.query("UPDATE app.runs SET status='running' WHERE id=$1", [
        run.id,
      ]);
      await tx.query(
        "UPDATE app.cells SET outcome='running' WHERE row_id=$1 AND column_id=$2",
        [s.row_id, s.column_id],
      );
      return {
        step: {
          ...s,
          fencing: String(BigInt(s.fencing) + 1n),
          input_fingerprint: inputFingerprint,
        },
        run,
        col,
        values,
        frozen,
        attemptIds: [] as string[],
      };
    });
  }
  async finishTx(
    tx: Tx,
    s: any,
    run: any,
    outcome: string,
    value: CellValue | null,
    reason: string | null,
    provenance: any,
  ) {
    await tx.query(
      "UPDATE app.steps SET outcome=$2,result=$3,reason=$4,provenance=$5,lease_until=NULL WHERE id=$1",
      [s.id, outcome, value, reason, provenance],
    );
    await tx.query("DELETE FROM app.reservations WHERE step_id=$1", [s.id]);
    if (outcome === "unknown")
      await tx.query(
        "UPDATE app.attempts SET dispatch_state='unknown',outcome='unknown' WHERE step_id=$1 AND dispatch_state IN('dispatch_intent','awaiting_result')",
        [s.id],
      );
    await tx.query(
      "UPDATE app.cells SET outcome=$3,stale=CASE WHEN $3 IN('succeeded','reused') THEN stale ELSE true END WHERE row_id=$1 AND column_id=$2",
      [s.row_id, s.column_id, outcome],
    );
    await finalizeRuns(tx, run.id);
  }
  async publish(
    job: any,
    outcome: string,
    value: CellValue | null,
    reason: string | null,
    provenance: any = null,
  ) {
    return this.db.transaction(async (tx) => {
      const table = (
        await tx.query(
          "SELECT id FROM app.tables WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
          [job.run.table_id, job.run.workspace_id],
        )
      ).rows[0];
      if (!table) return;
      const run = (
        await tx.query("SELECT * FROM app.runs WHERE id=$1 FOR UPDATE", [
          job.run.id,
        ])
      ).rows[0];
      const s = (
        await tx.query("SELECT * FROM app.steps WHERE id=$1 FOR UPDATE", [
          job.step.id,
        ])
      ).rows[0];
      if (
        !s ||
        s.outcome !== "running" ||
        String(s.fencing) !== job.step.fencing
      )
        return;
      const data = await loadTable(tx, run.workspace_id, run.table_id, false, [
        s.row_id,
      ]);
      const live = data.rows.find((r) => r.id === s.row_id);
      const stale =
        inputSignature(
          data.columns,
          s.column_id,
          Object.fromEntries(
            Object.entries(live?.cells ?? {}).map(([id, c]) => [
              id,
              (c as any).value,
            ]),
          ),
          Object.fromEntries(
            Object.entries(live?.cells ?? {}).map(([id, c]) => [
              id,
              (c as any).version,
            ]),
          ),
        ) !== job.step.input_fingerprint;
      await this.finishTx(tx, s, run, outcome, value, reason, provenance);
      if (outcome === "succeeded" && value) {
        await tx.query(
          "UPDATE app.cells SET value=$3,version=version+1,stale=$4,source_step_id=$5 WHERE row_id=$1 AND column_id=$2",
          [s.row_id, s.column_id, value, stale, s.id],
        );
      }
      await staleDependents(
        tx,
        run.table_id,
        data.columns,
        s.column_id,
        s.row_id,
      );
      await recalculate(tx, run.table_id, data.columns, [s.row_id]);
      await touch(tx, run.table_id);
    });
  }
  async authorize(job: any, provider: any, position: number) {
    return this.db.transaction(async (tx) => {
      await ownedTable(tx, job.run.workspace_id, job.run.table_id, true);
      const run = (
        await tx.query("SELECT * FROM app.runs WHERE id=$1 FOR UPDATE", [
          job.run.id,
        ])
      ).rows[0];
      const s = (
        await tx.query("SELECT * FROM app.steps WHERE id=$1 FOR UPDATE", [
          job.step.id,
        ])
      ).rows[0];
      if (
        !s ||
        s.outcome !== "running" ||
        String(s.fencing) !== job.step.fencing
      )
        return null;
      if (run.status === "cancel_requested") {
        await this.finishTx(
          tx,
          s,
          run,
          "canceled",
          null,
          "canceled_before_dispatch",
          null,
        );
        return null;
      }
      const c = (
        await tx.query(
          "SELECT * FROM app.connections WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
          [provider.ref.id, run.workspace_id],
        )
      ).rows[0];
      const p = this.policies.find((p) => p.providerKey === provider.key);
      if (
        !c ||
        c.status !== "ready" ||
        String(c.revision) !== provider.ref.revision ||
        c.provider_key !== provider.key ||
        !p?.enabledForRealRequests
      ) {
        await this.finishTx(tx, s, run, "failed", null, "provider_error", null);
        return null;
      }
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        run.workspace_id + ":" + provider.key,
      ]);
      const limits = (
        await tx.query(
          "SELECT (SELECT COUNT(*)::int FROM app.request_authorizations ra JOIN app.attempts aa ON aa.id=ra.attempt_id JOIN app.steps ss ON ss.id=aa.step_id JOIN app.runs rr ON rr.id=ss.run_id WHERE rr.workspace_id=$1 AND aa.provider_key=$2 AND ra.authorized_at>now()-interval '1 minute') AS recent,COUNT(*) FILTER(WHERE dispatch_state IN('dispatch_intent','awaiting_result') AND deadline_at>now())::int AS current FROM app.attempts a JOIN app.steps st ON st.id=a.step_id JOIN app.runs r ON r.id=st.run_id WHERE r.workspace_id=$1 AND a.provider_key=$2",
          [run.workspace_id, provider.key],
        )
      ).rows[0];
      if (
        limits.recent >= p.policy.requestsPerMinute! ||
        limits.current >= p.policy.maxConcurrent!
      ) {
        if (job.attemptIds.length)
          await this.finishTx(
            tx,
            s,
            run,
            "failed",
            null,
            "provider_error",
            null,
          );
        else
          await tx.query(
            "UPDATE app.steps SET outcome='queued',lease_until=NULL WHERE id=$1",
            [s.id],
          );
        return null;
      }
      let credentials: Credentials;
      try {
        credentials = decryptCredentials(
          c.ciphertext,
          this.key,
          JSON.stringify([run.workspace_id, c.id]),
        );
      } catch {
        await this.finishTx(tx, s, run, "failed", null, "provider_error", null);
        return null;
      }
      const id = uid();
      const deadline = new Date(Date.now() + p.policy.deadlineMs!);
      await tx.query(
        "INSERT INTO app.attempts(id,step_id,connection_id,connection_revision,provider_key,position,dispatch_state,deadline_at) VALUES($1,$2,$3,$4,$5,$6,'dispatch_intent',$7)",
        [id, s.id, c.id, c.revision, provider.key, position, deadline],
      );
      await tx.query(
        "INSERT INTO app.request_authorizations(id,attempt_id,position) VALUES($1,$2,0)",
        [uid(), id],
      );
      const observedAt = new Date().toISOString();
      await recordObservationTx(tx, run.workspace_id, {
        id: uid(),
        attributionKey: id,
        runId: run.id,
        attemptId: id,
        providerKey: provider.key,
        capability: job.col.definition.kind,
        sourceObservationKey: "dispatch",
        sourceRevision: null,
        observedAt,
        semantics: "unknown",
        units: { kind: "unknown" },
        reportedMoney: { kind: "unknown" },
        estimatedMoney: { kind: "unknown" },
      });
      job.attemptIds.push(id);
      return { id, credentials, policy: p, observedAt };
    });
  }
  async journal(
    job: any,
    attempt: any,
    envelope: ProviderEnvelope,
    sequence: number,
  ) {
    return this.db.transaction(async (tx) => {
      const exists = (
        await tx.query("SELECT id FROM app.attempts WHERE id=$1", [attempt.id])
      ).rowCount;
      const runExists = (
        await tx.query("SELECT id FROM app.runs WHERE id=$1", [job.run.id])
      ).rowCount;
      const r = envelope.result;
      await recordObservationTx(tx, job.run.workspace_id, {
        id: uid(),
        attributionKey: attempt.id,
        runId: runExists ? job.run.id : null,
        attemptId: exists ? attempt.id : null,
        providerKey: attempt.policy.providerKey,
        capability: job.col.definition.kind,
        sourceObservationKey: "response:" + sequence,
        sourceRevision: String(sequence),
        observedAt: attempt.observedAt,
        semantics: envelope.consumption ? "cumulative" : "unknown",
        units: envelope.consumption?.units
          ? { kind: "known", ...envelope.consumption.units }
          : { kind: "unknown" },
        reportedMoney: envelope.consumption?.reportedMoney
          ? { kind: "known", ...envelope.consumption.reportedMoney }
          : { kind: "unknown" },
        estimatedMoney: { kind: "unknown" },
      });
      if (exists)
        await tx.query(
          `UPDATE app.attempts SET dispatch_state=$2,task=$3,request_id=COALESCE($4,request_id),outcome=$5 WHERE id=$1 AND EXISTS(SELECT 1 FROM app.steps s WHERE s.id=app.attempts.step_id AND s.outcome='running' AND s.fencing=$6)`,
          [
            attempt.id,
            r.status === "pending"
              ? "awaiting_result"
              : r.status === "unknown"
                ? "unknown"
                : "resolved",
            r.status === "pending" ? r.task : null,
            envelope.requestId ?? null,
            r.status,
            job.step.fencing,
          ],
        );
    });
  }
  async tick() {
    await this.recover();
    const job = await this.claim();
    if (!job) return false;
    const d = job.col.definition;
    const invalid = inputIssue(job.col, job.values, new Set());
    if (invalid) {
      await this.publish(job, "skipped", null, "missing_input");
      return true;
    }
    if (d.kind === "formula") {
      try {
        const v = evaluateFormula(d.expression, job.values);
        if (v.value !== null && v.type !== d.returnType) throw Error("type");
        await this.publish(
          job,
          "succeeded",
          { type: d.returnType, value: v.value } as CellValue,
          "fresh_output",
        );
      } catch {
        await this.publish(job, "failed", null, "provider_error");
      }
      return true;
    }
    for (const [i, p] of refs(job.col).entries()) {
      let request: ProviderRequest;
      if (d.kind === "company")
        request = {
          capability: "company",
          domain: inputText(d.domainInput, job.values),
          output: d.output,
        };
      else if (d.kind === "ai")
        request = {
          capability: "ai",
          model: d.model,
          resolvedInstructions: resolveInstructions(
            d.instructionTemplate,
            job.values,
          ).resolvedInstructions,
          maxOutputTokens: 2048,
          tools: [],
          store: false,
        };
      else if (d.kind === "email") {
        const n = d.providers[i].nameMapping;
        request = {
          capability: "email",
          domain: inputText(d.domainInput, job.values),
          personName:
            n.mode === "full_name"
              ? {
                  mode: "full_name",
                  fullName: inputText(n.fullNameInput, job.values),
                }
              : {
                  mode: "mapped_parts",
                  givenName: inputText(n.givenNameInput, job.values),
                  familyName: inputText(n.familyNameInput, job.values),
                  source: n.source,
                },
        };
      } else return true;
      if (!ProviderRequestSchema.safeParse(request).success) {
        await this.publish(job, "skipped", null, "missing_input");
        return true;
      }
      const attempt = await this.authorize(job, p, i);
      if (!attempt) return true;
      let envelope: ProviderEnvelope;
      try {
        envelope = await this.gateway.execute(
          p.key as any,
          request,
          attempt.credentials,
          {
            signal: AbortSignal.timeout(
              Math.min(120000, attempt.policy.policy.deadlineMs!),
            ),
          },
        );
      } catch {
        envelope = {
          result: {
            status: "unknown",
            providerKey: p.key as any,
            reason: "lost_acknowledgement",
          },
        };
      }
      await this.journal(job, attempt, envelope, 0);
      let polls = 0;
      while (
        envelope.result.status === "pending" &&
        polls < (attempt.policy.policy.maxPolls ?? 0) &&
        Date.now() <
          new Date(attempt.observedAt).getTime() +
            attempt.policy.policy.deadlineMs!
      ) {
        // Persisted task retrieval is a separate authorization; cancellation/revocation stops new polls.
        await new Promise((r) => setTimeout(r, 50));
        const allowed = await this.db.transaction(async (tx) => {
          const run = (
            await tx.query(
              "SELECT status FROM app.runs WHERE id=$1 FOR UPDATE",
              [job.run.id],
            )
          ).rows[0];
          const s = (
            await tx.query(
              "SELECT outcome,fencing FROM app.steps WHERE id=$1",
              [job.step.id],
            )
          ).rows[0];
          const c = (
            await tx.query(
              "SELECT status,revision FROM app.connections WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
              [p.ref.id, job.run.workspace_id],
            )
          ).rows[0];
          if (
            !(
              run &&
              run.status !== "cancel_requested" &&
              s?.outcome === "running" &&
              String(s.fencing) === job.step.fencing &&
              c?.status === "ready" &&
              String(c.revision) === p.ref.revision
            )
          )
            return false;
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [job.run.workspace_id + ":" + p.key],
          );
          const recent = (
            await tx.query(
              "SELECT COUNT(*)::int AS count FROM app.request_authorizations ra JOIN app.attempts a ON a.id=ra.attempt_id JOIN app.steps s ON s.id=a.step_id JOIN app.runs r ON r.id=s.run_id WHERE r.workspace_id=$1 AND a.provider_key=$2 AND ra.authorized_at>now()-interval '1 minute'",
              [job.run.workspace_id, p.key],
            )
          ).rows[0].count;
          if (recent >= attempt.policy.policy.requestsPerMinute!) return false;
          await tx.query(
            "INSERT INTO app.request_authorizations(id,attempt_id,position) VALUES($1,$2,$3)",
            [uid(), attempt.id, polls + 1],
          );
          return true;
        });
        if (!allowed) break;
        const stillAllowed = await this.db.transaction(async (tx) => ({
          allowed: (
            await tx.query(
              "SELECT 1 FROM app.runs r JOIN app.steps s ON s.run_id=r.id JOIN app.connections c ON c.id=$3 AND c.workspace_id=r.workspace_id WHERE r.id=$1 AND r.status IN('queued','running') AND s.id=$2 AND s.outcome='running' AND s.fencing=$4 AND c.status='ready' AND c.revision=$5",
              [
                job.run.id,
                job.step.id,
                p.ref.id,
                job.step.fencing,
                p.ref.revision,
              ],
            )
          ).rowCount,
        }));
        if (!stillAllowed.allowed) break;
        try {
          envelope = await this.gateway.poll(
            p.key as any,
            envelope.result.task,
            attempt.credentials,
            {
              signal: AbortSignal.timeout(
                Math.max(
                  1,
                  Math.min(
                    120000,
                    new Date(attempt.observedAt).getTime() +
                      attempt.policy.policy.deadlineMs! -
                      Date.now(),
                  ),
                ),
              ),
            },
          );
        } catch {
          envelope = {
            result: {
              status: "unknown",
              providerKey: p.key as any,
              reason: "lost_acknowledgement",
            },
          };
        }
        await this.journal(job, attempt, envelope, ++polls);
      }
      const r = envelope.result;
      if (r.status === "pending") {
        await this.publish(job, "unknown", null, "uncertain_outcome");
        return true;
      }
      if (r.status === "succeeded") {
        await this.publish(
          job,
          "succeeded",
          { type: "text", value: r.output.value },
          "fresh_output",
          {
            providerKey: r.providerKey,
            retrievedAt: r.retrievedAt,
            verificationLabel: r.verification?.providerLabel ?? null,
            attemptIds: job.attemptIds,
          },
        );
        return true;
      }
      if (r.status === "no_result" && i + 1 < refs(job.col).length) continue;
      await this.publish(
        job,
        r.status === "unknown"
          ? "unknown"
          : r.status === "no_result"
            ? "no_result"
            : "failed",
        null,
        r.status === "unknown"
          ? "uncertain_outcome"
          : r.status === "no_result"
            ? "no_match"
            : "provider_error",
        {
          providerKey: p.key,
          retrievedAt: new Date().toISOString(),
          verificationLabel: null,
          attemptIds: job.attemptIds,
        },
      );
      return true;
    }
    return true;
  }
}
