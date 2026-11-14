import { createHash } from "node:crypto";
import {
  ImportConfirmRequestSchema,
  ImportMappingSchema,
  ImportPlanSchema,
  ExportRequestSchema,
  type CellValue,
  type Column,
} from "@leadwork/contracts";
import {
  parseCsv,
  csvHeaderIssues,
  parseEditableValue,
  exportCsv,
} from "@leadwork/engine";
import { Database, fail, type Tx } from "./db.js";
import {
  uid,
  workspace,
  loadTable,
  scopeRows,
  insertRows,
  recalculate,
  touch,
  valueType,
} from "./tables.js";
export const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export async function ownedPlan(
  tx: Tx,
  ws: string,
  id: string,
  kind: string,
  lock = true,
) {
  const q = await tx.query(
    `SELECT * FROM app.plans WHERE id=$1 AND workspace_id=$2 AND kind=$3${lock ? " FOR UPDATE" : ""}`,
    [id, ws, kind],
  );
  if (!q.rowCount) fail("not_found");
  return q.rows[0];
}
export class TransferService {
  constructor(readonly db: Database) {}
  async validate(tx: Tx, ws: string, tableId: string, raw: any) {
    const data = await loadTable(tx, ws, tableId, true);
    const issues: any[] = [];
    for (const h of csvHeaderIssues(raw.headers))
      issues.push({ rowIndex: null, sourceIndex: h.sourceIndex, code: h.code });
    if (!raw.headers.length)
      issues.push({ rowIndex: null, sourceIndex: null, code: "malformed_csv" });
    if (!Array.isArray(raw.mappings ?? [])) fail("invalid_mapping");
    const mappings = (raw.mappings ?? []).map((m: any) =>
      ImportMappingSchema.parse(m),
    );
    const ids = new Set<string>(),
      indices = new Set<number>(),
      newColumns: Column[] = [];
    for (const m of mappings) {
      if (indices.has(m.sourceIndex) || m.sourceIndex >= raw.headers.length)
        issues.push({
          rowIndex: null,
          sourceIndex: m.sourceIndex,
          code: "invalid_mapping",
        });
      indices.add(m.sourceIndex);
      if (m.destination.kind === "existing") {
        const col = data.columns.find((c) => c.id === m.destination.columnId);
        if (
          !col ||
          col.definition.kind !== "editable" ||
          col.definition.valueType !== m.destination.valueType ||
          ids.has(col.id)
        )
          issues.push({
            rowIndex: null,
            sourceIndex: m.sourceIndex,
            code: "invalid_mapping",
          });
        ids.add(m.destination.columnId);
      } else {
        const name = m.destination.name.trim();
        if (
          data.columns.some(
            (c) => c.name.trim().toLowerCase() === name.toLowerCase(),
          ) ||
          newColumns.some((c) => c.name.toLowerCase() === name.toLowerCase())
        )
          issues.push({
            rowIndex: null,
            sourceIndex: m.sourceIndex,
            code: "invalid_mapping",
          });
        newColumns.push({
          id: uid(),
          name,
          revision: "1",
          definition: { kind: "editable", valueType: m.destination.valueType },
        });
      }
    }
    if (!mappings.length)
      issues.push({
        rowIndex: null,
        sourceIndex: null,
        code: "invalid_mapping",
      });
    if (
      data.table.rowCount + raw.rows.length > 5000 ||
      data.columns.length + newColumns.length > 50
    )
      issues.push({
        rowIndex: null,
        sourceIndex: null,
        code: "capacity_exceeded",
      });
    for (let i = 0; i < raw.rows.length; i++)
      for (const m of mappings)
        try {
          parseEditableValue(
            m.destination.valueType,
            raw.rows[i][m.sourceIndex] ?? "",
          );
        } catch {
          issues.push({
            rowIndex: i,
            sourceIndex: m.sourceIndex,
            code:
              m.destination.valueType === "number"
                ? "invalid_number"
                : m.destination.valueType === "date"
                  ? "invalid_date"
                  : m.destination.valueType === "boolean"
                    ? "invalid_boolean"
                    : "invalid_mapping",
          });
        }
    const plan = {
      id: raw.id,
      revision: String(raw.revision),
      tableId,
      expectedTableRevision: data.table.revision,
      sourceFingerprint: hash([raw.headers, raw.rows, mappings]),
      expiresAt: raw.expiresAt,
      sourceBytes: raw.sourceBytes,
      headers: raw.headers,
      mappings,
      existingRows: data.table.rowCount,
      appendedRows: raw.rows.length,
      existingColumns: data.columns.length,
      createdColumns: newColumns.length,
      state: issues.length ? "needs_correction" : "ready",
      issues,
      previewRows: raw.rows.slice(0, 10),
    };
    return { raw: { ...raw, mappings, newColumns, plan }, plan };
  }
  async preview(owner: string, tableId: string, input: any) {
    if (
      typeof input.csvText !== "string" ||
      Buffer.byteLength(input.csvText) > 10_000_000
    )
      fail("capacity_exceeded");
    const parsed = parseCsv(input.csvText);
    if (parsed.rows.length > 5000) fail("capacity_exceeded");
    return this.db.transaction(async (tx) => {
      const ws = await workspace(tx, owner);
      const raw = {
        ...parsed,
        id: uid(),
        revision: "1",
        sourceBytes: Buffer.byteLength(input.csvText),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        mappings: input.mappings ?? [],
      };
      const { raw: payload, plan } = await this.validate(tx, ws, tableId, raw);
      await tx.query(
        "INSERT INTO app.plans(id,workspace_id,table_id,kind,expires_at,payload) VALUES($1,$2,$3,'import',$4,$5)",
        [raw.id, ws, tableId, raw.expiresAt, payload],
      );
      return plan;
    });
  }
  async correct(owner: string, id: string, input: any) {
    return this.db.transaction(async (tx) => {
      const ws = await workspace(tx, owner),
        p = await ownedPlan(tx, ws, id, "import");
      if (String(p.revision) !== input.expectedPlanRevision)
        fail("version_conflict");
      if (p.committed_result) fail("version_conflict");
      if (new Date(p.expires_at).getTime() <= Date.now()) fail("expired_plan");
      const raw = p.payload;
      if (input.headers) {
        if (
          !Array.isArray(input.headers) ||
          input.headers.length !== raw.headers.length ||
          input.headers.some((h: any) => typeof h !== "string")
        )
          fail("invalid_mapping");
        raw.headers = input.headers;
      }
      if (input.mappings) raw.mappings = input.mappings;
      if (!Array.isArray(input.corrections ?? [])) fail("invalid_value");
      for (const c of input.corrections ?? []) {
        if (
          !Number.isInteger(c.rowIndex) ||
          !Number.isInteger(c.sourceIndex) ||
          !raw.rows[c.rowIndex] ||
          c.sourceIndex < 0 ||
          c.sourceIndex >= raw.headers.length ||
          typeof c.replacementText !== "string"
        )
          fail("invalid_value");
        raw.rows[c.rowIndex][c.sourceIndex] = c.replacementText;
      }
      const correctedCsv = [raw.headers, ...raw.rows]
        .map((row: string[]) =>
          row
            .map((v) =>
              /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v,
            )
            .join(","),
        )
        .join("\r\n");
      raw.sourceBytes = Buffer.byteLength(correctedCsv);
      if (raw.sourceBytes > 10_000_000) fail("capacity_exceeded");
      raw.revision = String(BigInt(p.revision) + 1n);
      const validated = await this.validate(tx, ws, p.table_id, raw);
      await tx.query(
        "UPDATE app.plans SET revision=revision+1,payload=$2 WHERE id=$1",
        [id, validated.raw],
      );
      return validated.plan;
    });
  }
  async confirm(owner: string, id: string, input: unknown) {
    const request = ImportConfirmRequestSchema.parse(input);
    if (request.planId !== id) fail("invalid_value");
    return this.db.transaction(async (tx) => {
      const ws = await workspace(tx, owner);
      const lookup = await ownedPlan(tx, ws, id, "import", false);
      const data = await loadTable(tx, ws, lookup.table_id, true);
      const p = await ownedPlan(tx, ws, id, "import");
      const fingerprint = hash(request);
      if (p.committed_result) {
        if (
          p.committed_key !== request.idempotencyKey ||
          p.committed_fingerprint !== fingerprint
        )
          fail("idempotency_conflict");
        return p.committed_result;
      }
      if (String(p.revision) !== request.expectedPlanRevision)
        fail("version_conflict");
      if (new Date(p.expires_at).getTime() <= Date.now()) fail("expired_plan");
      if (data.table.revision !== p.payload.plan.expectedTableRevision)
        fail("version_conflict");
      const raw = p.payload;
      if (raw.plan.state !== "ready") fail("invalid_mapping");
      ImportPlanSchema.parse(raw.plan);
      if (
        data.table.rowCount + raw.rows.length > 5000 ||
        data.columns.length + raw.newColumns.length > 50
      )
        fail("capacity_exceeded");
      for (const [i, c] of raw.newColumns.entries())
        await tx.query(
          "INSERT INTO app.columns(id,table_id,name,position,definition) VALUES($1,$2,$3,$4,$5)",
          [c.id, p.table_id, c.name, data.columns.length + i, c.definition],
        );
      const columns = [...data.columns, ...raw.newColumns];
      let newIndex = 0;
      const destIds = raw.mappings.map((m: any) =>
        m.destination.kind === "existing"
          ? m.destination.columnId
          : raw.newColumns[newIndex++].id,
      );
      const values = raw.rows.map((row: string[]) =>
        Object.fromEntries(
          raw.mappings.map((m: any, i: number) => [
            destIds[i],
            parseEditableValue(m.destination.valueType, row[m.sourceIndex]),
          ]),
        ),
      );
      const rowIds = await insertRows(tx, p.table_id, columns, values);
      await recalculate(tx, p.table_id, columns, rowIds);
      await touch(tx, p.table_id);
      const result = {
        planId: id,
        tableId: p.table_id,
        tableRevision: String(BigInt(data.table.revision) + 1n),
        appendedRows: rowIds.length,
        createdColumnIds: raw.newColumns.map((c: Column) => c.id),
      };
      await tx.query(
        "UPDATE app.plans SET committed_key=$2,committed_fingerprint=$3,committed_result=$4 WHERE id=$1",
        [id, request.idempotencyKey, fingerprint, result],
      );
      return result;
    });
  }
  async export(owner: string, tableId: string, input: unknown) {
    const request = ExportRequestSchema.parse(input);
    if (request.tableId !== tableId) fail("invalid_value");
    return this.db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const data = await loadTable(tx, await workspace(tx, owner), tableId);
      if (data.view.revision !== request.expectedViewRevision)
        fail("version_conflict");
      const columns = request.columnIds.map((id) =>
        data.columns.find((c) => c.id === id),
      );
      if (columns.some((c) => !c)) fail("invalid_value");
      const rows = scopeRows(data, request.rowScope);
      const warnings = new Set<string>();
      for (const row of rows)
        for (const col of columns) {
          const cell = row.cells[col!.id];
          if (cell?.stale) warnings.add("stale");
          if (
            ["queued", "running", "failed", "unknown"].includes(cell?.outcome)
          )
            warnings.add(
              cell.outcome === "queued" || cell.outcome === "running"
                ? "pending"
                : cell.outcome,
            );
        }
      if (warnings.size && !request.acknowledgeStoredOutputWarnings)
        fail("consent_required", { warnings: [...warnings] });
      return exportCsv(
        columns.map((c) => c!.name),
        rows.map((r) =>
          columns.map(
            (c) =>
              r.cells[c!.id]?.value ??
              ({ type: valueType(c!), value: null } as CellValue),
          ),
        ),
      );
    });
  }
}
