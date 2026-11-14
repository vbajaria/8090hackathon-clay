import { createHash } from "node:crypto";
// JSONB and SQL join iteration can reorder object keys without changing data.
export function canonicalHash(value: unknown) {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
            )
          : v,
      ),
    )
    .digest("hex");
}
