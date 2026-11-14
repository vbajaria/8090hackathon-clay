import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const origin = "http://localhost:3000";
async function login(page, email) {
  await page.goto("/");
  await expect(
    page.getByText(
      "Development mode — local sign-in is not production authentication.",
    ),
  ).toBeVisible();
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "Sign in (development only)", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your tables", exact: true }),
  ).toBeVisible();
}
test("persisted import → reactive formula → explicitly confirmed reuse → stored CSV; second owner denied", async ({
  page,
  browser,
}) => {
  const token = randomUUID(),
    name = `Browser acceptance ${token}`;
  let tableId, other;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const health = await page.request.get("/api/health");
  expect((await health.json()).providerExecution).toBe("disabled");
  try {
    await login(page, `browser-${token}@fixture.example`);
    await page.getByLabel("New table name").fill(name);
    const created = page.waitForResponse(
      (r) => r.url().endsWith("/api/tables") && r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Create table", exact: true })
      .click();
    tableId = (await (await created).json()).id;
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Import CSV", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("CSV file")
      .setInputFiles({
        name: "synthetic.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          "Person name,Company name,Company domain,Email address\nAda Synthetic,Acme Synthetic,acme.example,\nGrace Synthetic,Other Synthetic,other.example,\n",
        ),
      });
    await expect(
      dialog.getByRole("combobox", { name: "Destination", exact: true }),
    ).toHaveCount(4);
    const table = await (
      await page.request.get(`/api/tables/${tableId}`)
    ).json();
    for (let i = 0; i < 4; i++)
      await dialog
        .getByRole("combobox", { name: "Destination", exact: true })
        .nth(i)
        .selectOption(table.columns[i].id);
    await dialog
      .getByRole("button", {
        name: "Validate staged corrections & mappings",
        exact: true,
      })
      .click();
    await expect(
      dialog.getByRole("button", {
        name: "Confirm append import",
        exact: true,
      }),
    ).toBeEnabled();
    const imported = page.waitForResponse(
      (r) => r.url().includes("/api/imports/") && r.url().endsWith("/confirm"),
    );
    await dialog
      .getByRole("button", { name: "Confirm append import", exact: true })
      .click();
    expect((await imported).ok()).toBe(true);
    expect(
      (await (await page.request.get(`/api/tables/${tableId}`)).json()).table
        .rowCount,
    ).toBe(2);
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page.getByRole("button", { name: "Add column", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Column name", { exact: true })
      .fill("Uppercase person");
    await dialog
      .getByRole("combobox", { name: "Column type", exact: true })
      .selectOption("formula");
    await dialog
      .getByLabel("Formula expression", { exact: true })
      .fill(`UPPER({{${table.columns[0].id}}})`);
    await dialog
      .getByRole("checkbox", { name: "Person name", exact: true })
      .check();
    await dialog
      .getByRole("button", { name: "Save configuration only", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "ADA SYNTHETIC succeeded",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Runs & results", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByRole("combobox", { name: "Row scope", exact: true })
      .selectOption("all");
    await dialog
      .getByRole("checkbox", {
        name: "Uppercase person (formula)",
        exact: true,
      })
      .check();
    await dialog
      .getByRole("button", {
        name: "Preview saved inputs and costs",
        exact: true,
      })
      .click();
    await expect(
      dialog.getByText("0 maximum external attempts (including polls)", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await (await page.request.get(`/api/runs?tableId=${tableId}`)).json(),
    ).toEqual([]);
    await dialog
      .getByRole("button", { name: "Confirm manual execution", exact: true })
      .click();
    await expect(
      dialog.getByRole("heading", { name: "completed", exact: true }),
    ).toBeVisible();
    const runs = await (
      await page.request.get(`/api/runs?tableId=${tableId}`)
    ).json();
    expect(runs).toHaveLength(1);
    const runId = runs[0].id;
    const before = await (await page.request.get(`/api/runs/${runId}`)).json();
    expect(before.results).toHaveLength(2);
    expect(before.attempts).toEqual([]);
    expect(
      before.results.every((r) => r.outcome === "reused" && !r.stale),
    ).toBe(true);
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    const person = page
      .getByRole("textbox", { name: /^Person name, row / })
      .first();
    await person.fill("Ada Browser");
    await person
      .locator("..")
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "ADA BROWSER succeeded", exact: true }),
    ).toBeVisible();
    const historic = await (
      await page.request.get(`/api/runs/${runId}`)
    ).json();
    expect(
      historic.results.find((r) => r.storedValue?.value === "ADA SYNTHETIC")
        .stale,
    ).toBe(true);
    await page.reload();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("button", { name: "ADA BROWSER succeeded", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Runs & results", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByRole("combobox", { name: "Inspect run", exact: true })
      .selectOption(runId);
    await expect(
      dialog.getByRole("heading", { name: "completed", exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Export saved CSV", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    const received = page.waitForEvent("download", { timeout: 10_000 });
    await dialog
      .getByRole("button", {
        name: "Confirm stored-value CSV download",
        exact: true,
      })
      .click();
    const download = await received;
    expect(await download.failure()).toBeNull();
    const csv = await readFile(await download.path(), "utf8");
    expect(csv).toContain(
      "Person name,Company name,Company domain,Email address,Uppercase person",
    );
    expect(csv).toContain(
      "Ada Browser,Acme Synthetic,acme.example,,ADA BROWSER",
    );
    const usage = await (
      await page.request.get(`/api/usage?runId=${runId}`)
    ).json();
    expect(usage.externalStarts).toBe(0);
    other = await browser.newContext({ baseURL: origin });
    const second = await other.newPage();
    await login(second, `other-${token}@fixture.example`);
    expect(await (await second.request.get("/api/tables")).json()).toEqual([]);
    expect((await second.request.get(`/api/tables/${tableId}`)).status()).toBe(
      404,
    );
    expect((await second.request.get(`/api/runs/${runId}`)).status()).toBe(404);
    expect(
      (
        await second.request.post(`/api/tables/${tableId}/export`, {
          headers: { origin },
          data: {
            tableId,
            rowScope: { kind: "all" },
            columnIds: [table.columns[0].id],
            expectedViewRevision: table.view.revision,
            acknowledgeStoredOutputWarnings: false,
            neutralizeSpreadsheetText: true,
          },
        })
      ).status(),
    ).toBe(404);
    expect(errors).toEqual([]);
  } finally {
    if (other) await other.close();
    if (tableId) {
      const deleted = await page.request.delete(`/api/tables/${tableId}`, {
        headers: { origin },
        data: { confirmed: true },
      });
      expect(deleted.ok()).toBe(true);
    }
  }
});
