import { expect, test, type Page } from "@playwright/test";

const SENDER = "http://127.0.0.1:5181/";
const RECEIVER = "http://localhost:5182/";

async function sendFromSequenceApp(
  page: Page,
  options: { format: "newick" | "fasta"; url?: string } = { format: "newick" },
): Promise<Page> {
  await page.goto(options.url ?? SENDER);
  await page.locator("#target").fill(RECEIVER);
  await page.locator("#format").selectOption(options.format);

  const receiverPage = page.waitForEvent("popup");
  await page.locator("#send").click();
  const receiver = await receiverPage;
  await receiver.waitForLoadState("domcontentloaded").catch(() => undefined);
  return receiver;
}

test("transfers a Newick tree across origins after explicit approval", async ({ page }) => {
  const receiver = await sendFromSequenceApp(page);

  await expect(receiver.locator("[data-cdep-consent] h2")).toHaveText("Incoming dataset");
  await expect(receiver.locator("#leaves")).toHaveText("No tree");
  expect(await receiver.evaluate(() => window.opener !== null)).toBe(true);
  await expect(
    receiver.locator("[data-cdep-consent] dd").filter({ hasText: "http://127.0.0.1:5181" }),
  ).toHaveCount(1);
  await expect(receiver.locator("[data-cdep-consent] dd").filter({ hasText: "tree.newick" })).toHaveCount(1);

  await receiver.locator("[data-cdep-consent] button.accept").click();

  await expect(receiver.locator("#leaves")).toHaveAttribute("data-count", "4");
  await expect(receiver.locator("#session")).toHaveAttribute("data-state", "IMPORTED");
  await expect(receiver.locator("#source")).toContainText("http://127.0.0.1:5181");

  await expect(page.locator("#status")).toContainText("Imported");
  await expect(page.locator("#status")).toContainText("org.cdep.format.newick.v1");

  // The invite nonce is single-use and must not survive the handshake.
  expect(receiver.url()).not.toContain("cdep-sid");
  expect(new URL(receiver.url()).origin).toBe("http://localhost:5182");
  expect(receiver.isClosed()).toBe(false);
});

test("a declined offer ends the transfer without importing anything", async ({ page }) => {
  const receiver = await sendFromSequenceApp(page);

  await receiver.locator("[data-cdep-consent] button.decline").click();

  await expect(page.locator("#status")).toContainText("REJECTED");
  await expect(page.locator("#status")).toHaveAttribute("data-kind", "error");
  await expect.poll(() => receiver.isClosed()).toBe(true);
});

test("an unsupported format is rejected before any payload is produced", async ({ page }) => {
  const receiver = await sendFromSequenceApp(page, { format: "fasta" });

  await expect(page.locator("#status")).toContainText("NO_COMMON_FORMAT");
  await expect(page.locator("#status")).toHaveAttribute("data-kind", "error");
  await expect.poll(() => receiver.isClosed()).toBe(true);
});

test("an oversized dataset fails safely before an offer is made", async ({ page }) => {
  const receiver = await sendFromSequenceApp(page, {
    format: "newick",
    url: `${SENDER}?fixture=oversize`,
  });

  await expect(page.locator("#status")).toContainText("SIZE_EXCEEDED");
  await expect(page.locator("#status")).toHaveAttribute("data-kind", "error");
  await expect.poll(() => receiver.isClosed()).toBe(true);
});

test("the sender's edited Newick draft is what the receiver imports", async ({ page }) => {
  await page.goto(SENDER);
  await page.locator("#target").fill(RECEIVER);
  await page.locator("#tree-editor").fill(
    "((sample_1:0.1,sample_2:0.2):0.3,sample_3:0.4,edited_leaf:0.5);",
  );
  await expect(page.locator("#tree-status")).toHaveAttribute("data-valid", "true");

  const receiverPage = page.waitForEvent("popup");
  await page.locator("#send").click();
  const receiver = await receiverPage;
  await receiver.waitForLoadState("domcontentloaded").catch(() => undefined);
  await receiver.locator("[data-cdep-consent] button.accept").click();

  await expect(receiver.locator("#leaves")).toHaveAttribute("data-count", "4");
  await expect(receiver.locator("#tree text").filter({ hasText: "edited_leaf" })).toHaveCount(1);
  await expect(page.locator("#status")).toContainText("Imported");
});

test("an invalid Newick draft is refused before a window opens", async ({ page, context }) => {
  await page.goto(SENDER);
  await page.locator("#tree-editor").fill("((sample_1,sample_2)");
  await expect(page.locator("#tree-status")).toHaveAttribute("data-valid", "false");

  await page.locator("#send").click();
  await expect(page.locator("#status")).toContainText("Fix the Newick draft");
  await expect(page.locator("#status")).toHaveAttribute("data-kind", "error");
  await expect.poll(() => context.pages().length).toBe(1);
});

test("a receiver page starts empty and can load a Newick file locally", async ({ page }) => {
  await page.goto(RECEIVER);
  await expect(page.locator("#leaves")).toHaveText("No tree");
  await expect(page.locator("#send")).toBeDisabled();
  await expect(page.locator("#tree")).toBeHidden();

  await page.locator("#tree-file").setInputFiles({
    name: "local.nwk",
    mimeType: "text/plain",
    buffer: Buffer.from("((a:0.1,b:0.2):0.3,c:0.4);"),
  });

  await expect(page.locator("#leaves")).toHaveAttribute("data-count", "3");
  await expect(page.locator("#tree text").filter({ hasText: "a" })).toHaveCount(1);
  await expect(page.locator("#source")).toContainText("local.nwk");
  await expect(page.locator("#send")).toBeEnabled();
});

test("a malformed Newick upload is reported and leaves the tree empty", async ({ page }) => {
  await page.goto(RECEIVER);
  await page.locator("#tree-file").setInputFiles({
    name: "broken.nwk",
    mimeType: "text/plain",
    buffer: Buffer.from("((a,b)"),
  });

  await expect(page.locator("#status")).toContainText("Could not parse");
  await expect(page.locator("#status")).toHaveAttribute("data-kind", "error");
  await expect(page.locator("#leaves")).toHaveText("No tree");
  await expect(page.locator("#send")).toBeDisabled();
});
