import { z } from "zod";
import { IdSchema, apiError } from "@leadwork/contracts";
import { resolveInstructions, DomainError } from "@leadwork/engine";
import { capabilityCatalog, createGateway } from "@leadwork/providers";
import { Database, ServiceError, fail } from "./db.js";
import { createAuth, assertMutationOrigin, type AuthOptions } from "./auth.js";
import { TableService, workspace, loadTable } from "./tables.js";
import { TransferService } from "./transfer.js";
import {
  ConnectionService,
  validatePolicies,
  type Policy,
} from "./connections.js";
import { Planner } from "./planner.js";
import { RunService } from "./runs.js";
import { Worker } from "./worker.js";
import { usageSummary } from "./ledger.js";
export type AppOptions = {
  db?: Database;
  key?: string;
  gateway?: ReturnType<typeof createGateway>;
  policies?: Policy[];
  authOptions?: AuthOptions;
};
function merge(to: Headers, from?: Headers) {
  if (!from) return;
  for (const [k, v] of from) if (k !== "set-cookie") to.set(k, v);
  for (const c of from.getSetCookie()) to.append("set-cookie", c);
}
async function json(request: Request) {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    fail("invalid_value");
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 21_000_000) {
        await reader.cancel();
        fail("capacity_exceeded");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    fail("invalid_value");
  }
}
export function createApp(options: AppOptions = {}) {
  const production = process.env.NODE_ENV === "production";
  if (
    production &&
    ((!process.env.DATABASE_URL && !options.db) ||
      (!process.env.CREDENTIAL_ENCRYPTION_KEY && !options.key))
  )
    fail("provider_not_ready");
  const db =
    options.db ??
    new Database(
      process.env.DATABASE_URL ??
        "postgresql://leadwork:leadwork-local-only@localhost:5432/leadwork",
    );
  const key = options.key ?? process.env.CREDENTIAL_ENCRYPTION_KEY ?? "";
  const policies =
    options.policies ??
    (process.env.PROVIDER_POLICIES_JSON
      ? validatePolicies(JSON.parse(process.env.PROVIDER_POLICIES_JSON))
      : [...capabilityCatalog]);
  const gateway =
    options.gateway ??
    createGateway({
      allowRealRequests:
        process.env.ALLOW_REAL_PROVIDER_REQUESTS === "true" &&
        policies.some((p) => p.enabledForRealRequests),
    });
  const auth = createAuth(options.authOptions),
    tables = new TableService(db),
    transfer = new TransferService(db),
    connections = new ConnectionService(db, key, gateway, policies),
    planner = new Planner(db, policies),
    runs = new RunService(db),
    worker = new Worker(db, key, gateway, policies);
  const buckets = new Map<string, { count: number; end: number }>();
  function rate(id: string, max: number) {
    const now = Date.now();
    if (buckets.size > 10000)
      for (const [id, b] of buckets) if (b.end < now) buckets.delete(id);
    let b = buckets.get(id);
    if (!b || b.end < now) {
      b = { count: 0, end: now + 60000 };
      buckets.set(id, b);
    }
    if (++b.count > max) fail("capacity_exceeded");
  }
  async function handle(request: Request): Promise<Response> {
    const headers = new Headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const respond = (body: unknown, status = 200) => {
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify(body), { status, headers });
    };
    try {
      const url = new URL(request.url),
        path = url.pathname
          .replace(/^\/api\/?/, "")
          .split("/")
          .filter(Boolean),
        method = request.method;
      const mutating = !["GET", "HEAD"].includes(method);
      if (mutating)
        assertMutationOrigin(
          request,
          options.authOptions?.appOrigin ?? process.env.APP_ORIGIN,
        );
      if (path.join("/") === "health" && method === "GET") {
        await db.pool.query("SELECT 1");
        return respond({
          status: "ready",
          providerExecution: policies.some((p) => p.enabledForRealRequests)
            ? "policy_gated"
            : "disabled",
        });
      }
      if (path[0] === "auth") {
        if (path[1] === "session" && method === "GET") {
          const s = await auth.session(request);
          merge(headers, s.headers);
          return respond({ user: s.user, mode: s.mode });
        }
        if (path[1] === "login" && method === "POST") {
          rate("login", 20);
          const body = z
            .object({ email: z.string() })
            .strict()
            .parse(await json(request));
          const r = await auth.login(request, body.email);
          merge(headers, r.headers);
          return respond(r.body);
        }
        if (path[1] === "logout" && method === "POST") {
          const r = await auth.logout(request);
          merge(headers, r.headers);
          return respond(r.body);
        }
        if (path[1] === "callback" && method === "GET") {
          const r = await auth.callback(request);
          merge(headers, r.headers);
          headers.set("location", (r.body as { next: string }).next);
          return new Response(null, { status: 303, headers });
        }
        fail("not_found");
      }
      const session = await auth.session(request);
      merge(headers, session.headers);
      if (!session.user) fail("unauthenticated");
      const owner = session.user.id;
      if (mutating) rate(owner, 200);
      const body = mutating ? await json(request) : undefined;
      let result: unknown;
      const id = () => IdSchema.parse(path[1]);
      if (path[0] === "tables") {
        if (path.length === 1) {
          if (method === "GET") result = await tables.list(owner);
          else if (method === "POST")
            result = await tables.create(
              owner,
              z
                .object({ name: z.string().trim().min(1).max(254) })
                .strict()
                .parse(body).name,
            );
          else fail("not_found");
        } else {
          const tableId = id();
          if (path.length === 2) {
            if (method === "GET") {
              const limit = Number(url.searchParams.get("limit") ?? 100);
              if (!Number.isInteger(limit) || limit < 1 || limit > 250)
                fail("invalid_value");
              result = await tables.read(
                owner,
                tableId,
                url.searchParams.get("cursor") ?? undefined,
                limit,
              );
            } else if (method === "DELETE") {
              if (body.confirmed !== true) fail("consent_required");
              await tables.remove(owner, tableId);
              result = { ok: true };
            } else fail("not_found");
          } else if (path[2] === "rows") {
            if (method === "POST") result = await tables.addRow(owner, tableId);
            else if (method === "DELETE") {
              if (body.confirmed !== true) fail("consent_required");
              const rows = z
                .array(IdSchema)
                .min(1)
                .max(5000)
                .parse(body.rowIds);
              await tables.remove(owner, tableId, rows);
              result = { ok: true };
            } else fail("not_found");
          } else if (path[2] === "cells" && method === "PATCH")
            result = await tables.patch(owner, tableId, body);
          else if (path[2] === "copy-draft" && method === "POST")
            result = await tables.copyDraft(
              owner,
              tableId,
              z
                .object({
                  rowId: IdSchema,
                  sourceColumnId: IdSchema,
                  destinationColumnId: IdSchema,
                  expectedVersion: z.string().regex(/^\d+$/),
                  overwrite: z.boolean(),
                })
                .strict()
                .parse(body),
            );
          else if (path[2] === "columns") {
            if (method === "POST")
              result = await tables.saveColumn(owner, tableId, body);
            else if (method === "PATCH" && path[3])
              result = await tables.saveColumn(
                owner,
                tableId,
                body,
                IdSchema.parse(path[3]),
              );
            else if (method === "DELETE" && path[3]) {
              if (body.confirmed !== true) fail("consent_required");
              await tables.deleteColumn(
                owner,
                tableId,
                IdSchema.parse(path[3]),
                body.expectedRevision,
              );
              result = { ok: true };
            } else fail("not_found");
          } else if (path[2] === "view" && method === "PUT")
            result = await tables.saveView(owner, tableId, body);
          else if (
            path[2] === "import" &&
            path[3] === "preview" &&
            method === "POST"
          )
            result = await transfer.preview(owner, tableId, body);
          else if (path[2] === "export" && method === "POST") {
            const csv = await transfer.export(owner, tableId, body);
            headers.set("content-type", "text/csv; charset=utf-8");
            headers.set(
              "content-disposition",
              'attachment; filename="leadwork.csv"',
            );
            return new Response(csv, { headers });
          } else if (path[2] === "ai-preview" && method === "POST") {
            result = await db.transaction(async (tx) => {
              const data = await loadTable(
                tx,
                await workspace(tx, owner),
                tableId,
              );
              const col = data.columns.find(
                  (c) => c.id === IdSchema.parse(body.columnId),
                ),
                row = data.rows.find(
                  (r) => r.id === IdSchema.parse(body.rowId),
                );
              if (!col || col.definition.kind !== "ai" || !row)
                fail("not_found");
              return resolveInstructions(
                col.definition.instructionTemplate,
                Object.fromEntries(
                  Object.entries(row.cells).map(([id, c]) => [
                    id,
                    (c as any).value,
                  ]),
                ),
              );
            });
          } else fail("not_found");
        }
      } else if (path[0] === "imports" && method === "POST") {
        const planId = id();
        if (path[2] === "correct")
          result = await transfer.correct(owner, planId, body);
        else if (path[2] === "confirm")
          result = await transfer.confirm(owner, planId, body);
        else fail("not_found");
      } else if (path[0] === "connections") {
        if (path.length === 1 && method === "GET")
          result = await connections.list(owner);
        else if (path.length === 1 && method === "POST")
          result = await connections.create(owner, body);
        else if (path[2] === "validate" && method === "POST")
          result = await connections.validate(owner, id());
        else if (path.length === 2 && method === "DELETE") {
          await connections.disconnect(owner, id());
          result = { ok: true };
        } else fail("not_found");
      } else if (path[0] === "runs") {
        if (path[1] === "preview" && method === "POST")
          result = await planner.preview(owner, body);
        else if (path[1] === "confirm" && method === "POST")
          result = await planner.confirm(owner, body);
        else if (path.length === 1 && method === "GET") {
          const t = url.searchParams.get("tableId");
          result = await runs.list(owner, t ? IdSchema.parse(t) : undefined);
        } else if (path.length === 2 && method === "GET")
          result = await runs.detail(
            owner,
            id(),
            url.searchParams.get("cursor") ?? undefined,
            Number(url.searchParams.get("limit") ?? 50),
          );
        else if (path[2] === "cancel" && method === "POST")
          result = await runs.cancel(owner, id());
        else if (path[2] === "retry-preview" && method === "POST")
          result = await planner.retry(owner, id(), body);
        else fail("not_found");
      } else if (path[0] === "usage" && method === "GET") {
        const ws = await db.transaction((tx) => workspace(tx, owner));
        result = await usageSummary(
          db,
          ws,
          url.searchParams.get("month") ?? undefined,
          url.searchParams.get("runId") ?? undefined,
        );
      } else fail("not_found");
      return respond(result);
    } catch (error) {
      if (error instanceof ServiceError)
        return respond(
          { error: error.error, ...error.extra },
          error.error.status,
        );
      const code =
        error instanceof z.ZodError || error instanceof DomainError
          ? "invalid_value"
          : (error as any)?.code === "23505"
            ? "invalid_value"
            : (error as any)?.code === "23514"
              ? "capacity_exceeded"
              : "internal_error";
      const safe = apiError(code);
      return respond({ error: safe }, safe.status);
    }
  }
  return {
    db,
    handle,
    auth,
    tables,
    transfer,
    connections,
    planner,
    runs,
    worker,
  };
}
