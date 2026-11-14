import {randomUUID} from 'node:crypto';
import {IdSchema, UsageObservationSchema, UsageQuerySchema, UsageSummarySchema, type UsageObservation} from '@leadwork/contracts';
import type {z} from 'zod';
import {Database, ServiceError, fail, type Tx} from './db.js';

export type UsageSummary = z.infer<typeof UsageSummarySchema>;
type History = {
  id:string; run_id:string|null; attempt_id:string|null; provider_key:string; capability:string;
  request_time:Date; observation_key:string; source_revision:string|null; semantics:string;
  units:string|null; unit_kind:string|null; reported_amount:string|null; currency:string|null; estimated_amount:string|null;
};
// Never expose SQL, driver diagnostics, validation input, or provider data.
function safeServiceError(error:unknown):never {
  if(error instanceof ServiceError) throw error;
  return fail('internal_error');
}
function validId(id:string) {if(!IdSchema.safeParse(id).success) fail('invalid_value');}
async function workspace(tx:Tx,id:string) {
  validId(id);
  if(!(await tx.query('SELECT id FROM app.workspaces WHERE id=$1',[id])).rowCount) fail('not_found');
}
async function ownedRun(tx:Tx,workspaceId:string,runId:string) {
  if(!(await tx.query('SELECT id FROM app.runs WHERE id=$1 AND workspace_id=$2',[runId,workspaceId])).rowCount) fail('not_found');
}
function newer(a:History,b:History):boolean {
  if(a.source_revision!==null || b.source_revision!==null) {
    if(a.source_revision===null) return false;
    if(b.source_revision===null) return true;
    return BigInt(a.source_revision)>BigInt(b.source_revision);
  }
  return a.request_time.getTime()>b.request_time.getTime();
}
async function quantity(tx:Tx,history:History[],field:'units'|'reported_amount',previousKey:string|null) {
  const candidates=history.filter(o=>o[field]!==null);
  const cumulative=candidates.filter(o=>o.semantics==='cumulative');
  // Equal revisions are not corrections. Preserve the chosen baseline on ties.
  let baseline=cumulative.find(o=>o.observation_key===previousKey);
  for(const o of cumulative) if(!baseline || newer(o,baseline)) baseline=o;
  const deltas=candidates.filter(o=>o.semantics==='delta' && (!baseline || newer(o,baseline)));
  const values=[...(baseline?[baseline[field]!]:[]),...deltas.map(o=>o[field]!)];
  const amount=values.length ? (await tx.query<{amount:string}>('SELECT SUM(value)::text AS amount FROM unnest($1::numeric[]) AS value',[values])).rows[0]!.amount : null;
  let latest=baseline;
  for(const o of deltas) if(!latest || newer(o,latest)) latest=o;
  return {amount,latest,baseline};
}

export async function recordObservation(db:Database,workspaceId:string,observation:UsageObservation):Promise<void> {
  try {await db.transaction(tx=>recordObservationTx(tx,workspaceId,observation));} catch(error) {safeServiceError(error);}
}

/** Caller owns BEGIN/COMMIT, including the worker's already-locked transaction. */
export async function recordObservationTx(tx:Tx,workspaceId:string,observation:UsageObservation):Promise<void> {
  try {
    const parsed=UsageObservationSchema.safeParse(observation);
    if(!parsed.success) return fail('invalid_value');
    const o=parsed.data;
    // The current history schema has one currency column for both amounts.
    if(o.reportedMoney.kind==='known' && o.estimatedMoney.kind==='known' && o.reportedMoney.currency!==o.estimatedMoney.currency) return fail('invalid_value');
    if(o.sourceRevision!==null && BigInt(o.sourceRevision)>9223372036854775807n) fail('invalid_value');
    await workspace(tx,workspaceId);
    if(o.runId!==null) await ownedRun(tx,workspaceId,o.runId);
    if(o.attemptId!==null) {
      const attempt=await tx.query<{run_id:string}>(`SELECT s.run_id FROM app.attempts a JOIN app.steps s ON s.id=a.step_id
        JOIN app.runs r ON r.id=s.run_id WHERE a.id=$1 AND r.workspace_id=$2`,[o.attemptId,workspaceId]);
      if(!attempt.rowCount) fail('not_found');
      if(o.runId!==null && attempt.rows[0]!.run_id!==o.runId) fail('invalid_value');
    }
    // Per-attribution serialization, shared by standalone calls and worker calls.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${workspaceId}:${o.attributionKey}`]);
    const existing=(await tx.query<History>('SELECT * FROM app.usage_observations WHERE workspace_id=$1 AND attribution_key=$2 ORDER BY request_time,id',[workspaceId,o.attributionKey])).rows;
    if(existing.some(h=>h.provider_key!==o.providerKey || h.capability!==o.capability || (h.run_id!==null && o.runId!==null && h.run_id!==o.runId) || (h.attempt_id!==null && o.attemptId!==null && h.attempt_id!==o.attemptId))) fail('invalid_value');
    const inserted=await tx.query(`INSERT INTO app.usage_observations
      (id,workspace_id,attribution_key,run_id,attempt_id,provider_key,capability,request_time,observation_key,source_revision,semantics,units,unit_kind,reported_amount,currency,estimated_amount)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT(workspace_id,attribution_key,observation_key) DO NOTHING`,[
      o.id,workspaceId,o.attributionKey,o.runId,o.attemptId,o.providerKey,o.capability,o.observedAt,o.sourceObservationKey,o.sourceRevision,o.semantics,
      o.units.kind==='known'?o.units.amount:null,o.units.kind==='known'?o.units.unitKind:null,
      o.reportedMoney.kind==='known'?o.reportedMoney.amount:null,
      o.reportedMoney.kind==='known'?o.reportedMoney.currency:o.estimatedMoney.kind==='known'?o.estimatedMoney.currency:null,
      o.estimatedMoney.kind==='known'?o.estimatedMoney.amount:null,
    ]);
    if(!inserted.rowCount) return;
    const history=(await tx.query<History>('SELECT * FROM app.usage_observations WHERE workspace_id=$1 AND attribution_key=$2 ORDER BY request_time,id',[workspaceId,o.attributionKey])).rows;
    const previous=(await tx.query<{unit_kind:string;currency:string;observation_key:string|null}>('SELECT unit_kind,currency,observation_key FROM app.consumption WHERE workspace_id=$1 AND attribution_key=$2',[workspaceId,o.attributionKey])).rows;
    const persistedTime=(await tx.query<{request_time:Date}>('SELECT request_time FROM app.consumption WHERE workspace_id=$1 AND attribution_key=$2 LIMIT 1',[workspaceId,o.attributionKey])).rows[0]?.request_time;
    // Orthogonal dimensions: unit totals are never duplicated for multiple currencies.
    const dimensions=[...new Set(history.filter(h=>h.units!==null).map(h=>h.unit_kind!))].map(unit=>({unit,currency:''}));
    dimensions.push(...[...new Set(history.filter(h=>h.reported_amount!==null || h.estimated_amount!==null).map(h=>h.currency!))].map(currency=>({unit:'',currency})));
    if(!dimensions.length) dimensions.push({unit:'',currency:''});
    else await tx.query("DELETE FROM app.consumption WHERE workspace_id=$1 AND attribution_key=$2 AND unit_kind='' AND currency=''",[workspaceId,o.attributionKey]);
    const runId=history.find(h=>h.run_id!==null)?.run_id??null;
    const attemptId=history.find(h=>h.attempt_id!==null)?.attempt_id??null;
    // The contract currently provides observedAt only. Keep the first attribution
    // timestamp stable rather than assigning late polling/corrections a new month.
    const first=persistedTime ?? existing[0]?.request_time ?? new Date(o.observedAt);
    for(const d of dimensions) {
      const rows=history.filter(h=>d.unit ? h.unit_kind===d.unit : d.currency ? h.currency===d.currency : true);
      const key=previous.find(p=>p.unit_kind===d.unit && p.currency===d.currency)?.observation_key??null;
      const confirmed=await quantity(tx,rows,d.unit?'units':'reported_amount',key);
      let estimate:History|undefined;
      for(const h of rows) if(h.estimated_amount!==null && (!estimate || newer(h,estimate))) estimate=h;
      // A newer delta does not become the cumulative baseline identity.
      const authority=confirmed.baseline??confirmed.latest;
      await tx.query(`INSERT INTO app.consumption
        (id,workspace_id,attribution_key,run_id,attempt_id,provider_key,capability,request_time,unit_kind,currency,units,reported_amount,estimated_amount,source_revision,observation_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT(workspace_id,attribution_key,unit_kind,currency) DO UPDATE SET
        run_id=EXCLUDED.run_id,attempt_id=EXCLUDED.attempt_id,units=EXCLUDED.units,reported_amount=EXCLUDED.reported_amount,
        estimated_amount=EXCLUDED.estimated_amount,source_revision=EXCLUDED.source_revision,observation_key=EXCLUDED.observation_key,revision=app.consumption.revision+1`,[
        randomUUID(),workspaceId,o.attributionKey,runId,attemptId,o.providerKey,o.capability,first,d.unit,d.currency,
        d.unit?confirmed.amount:null,d.currency?confirmed.amount:null,d.currency?estimate?.estimated_amount??null:null,
        authority?.source_revision??null,authority?.observation_key??null,
      ]);
    }
  } catch(error) {safeServiceError(error);}
}

/** UTC calendar months; NULL means unavailable, not a numeric zero. */
export async function usageSummary(db:Database,workspaceId:string,month?:string,runId?:string):Promise<UsageSummary> {
  try {
    const query=UsageQuerySchema.safeParse({month,runId});
    if(!query.success) fail('invalid_value');
    const period=month??new Date().toISOString().slice(0,7);
    if(period.startsWith('0000-') || period.startsWith('9999-12')) fail('invalid_value');
    const start=new Date(`${period}-01T00:00:00.000Z`);
    const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
    return await db.transaction(async tx=>{
      await workspace(tx,workspaceId);
      if(runId!==undefined) await ownedRun(tx,workspaceId,runId);
      const result=await tx.query<{provider_key:UsageSummary['totals'][number]['providerKey'];unit_kind:string;currency:string;units:string|null;reported_amount:string|null;estimated_amount:string|null;unknown_attempts:string;external_starts:string}>(`
        WITH selected AS (
          SELECT * FROM app.consumption WHERE workspace_id=$1 AND request_time >= $2 AND request_time < $3
          AND ($4::uuid IS NULL OR run_id=$4)
        ), attribution AS (
          SELECT attribution_key,bool_or(units IS NOT NULL) AS has_units,bool_or(reported_amount IS NOT NULL) AS has_money
          FROM selected GROUP BY attribution_key
        ) SELECT s.provider_key,s.unit_kind,s.currency,SUM(s.units)::text AS units,
          SUM(s.reported_amount)::text AS reported_amount,SUM(s.estimated_amount)::text AS estimated_amount,
          COUNT(DISTINCT s.attribution_key) FILTER(WHERE NOT a.has_units OR NOT a.has_money)::text AS unknown_attempts,
          (SELECT COUNT(*)::text FROM attribution) AS external_starts
        FROM selected s JOIN attribution a USING(attribution_key)
        GROUP BY s.provider_key,s.unit_kind,s.currency ORDER BY s.provider_key,s.unit_kind,s.currency`,[workspaceId,start,end,runId??null]);
      return UsageSummarySchema.parse({periodStart:start.toISOString(),periodEnd:end.toISOString(),externalStarts:Number(result.rows[0]?.external_starts??0),totals:result.rows.map(r=>({
        providerKey:r.provider_key,units:r.units===null?{kind:'unknown'}:{kind:'known',amount:r.units,unitKind:r.unit_kind},
        reportedMoney:r.reported_amount===null?{kind:'unknown'}:{kind:'known',amount:r.reported_amount,currency:r.currency},
        estimatedMoney:r.estimated_amount===null?{kind:'unknown'}:{kind:'known',amount:r.estimated_amount,currency:r.currency},unknownAttempts:Number(r.unknown_attempts),
      }))});
    });
  } catch(error) {return safeServiceError(error);}
}
