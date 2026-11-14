import { createApp } from "@leadwork/core";
const app = createApp();
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
await app.db.pool.query("SELECT 1");
console.log("Leadwork worker ready; manual persisted runs only.");
try {
  while (!stopping) {
    try {
      const worked = await app.worker.tick();
      if (!worked) await new Promise((r) => setTimeout(r, 500));
    } catch {
      console.error(
        "Worker iteration failed safely; persisted state will be reconciled.",
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
} finally {
  await app.db.close();
}
