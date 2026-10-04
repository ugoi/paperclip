import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Locator, type Page } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

// A keyboard shrinks visualViewport without shrinking the layout viewport.
// setViewportSize alone cannot reproduce this regression. Native device testing
// is still required to cover the actual IME and its viewport event sequence.
async function keyboardHeight(page: Page, height: number) {
  await page.evaluate((height) => {
    Object.defineProperty(window.visualViewport, "height", { configurable: true, value: height });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  }, height);
}

async function insideKeyboardViewport(element: Locator) {
  await expect.poll(async () => element.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.visualViewport!.height;
  })).toBe(true);
}

async function swipe(page: Page, scrollArea: Locator) {
  const session = await page.context().newCDPSession(page);
  try {
    const box = (await scrollArea.boundingBox())!;
    const x = box.x + box.width / 2;
    const start = box.y + box.height - 6;
    const distance = Math.max(1, box.height - 12);
    const before = await scrollArea.evaluate((el) => el.scrollTop);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: start }] });
    for (let step = 1; step <= 12; step += 1) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: start - distance * step / 12 }] });
      await page.waitForTimeout(20);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => scrollArea.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  } finally {
    await session.detach();
  }
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/announcements/current", (route) => route.fulfill({ json: null }));
});

test.use({ viewport: { width: 360, height: 452 }, hasTouch: true, isMobile: true });

test("composer lists stay above the keyboard and scroll to the last model", async ({ page, request, browserName }) => {
  test.skip(browserName !== "chromium", "Touch drags use Chromium input.");
  const company = await json(await request.post("/api/companies", { data: { name: `Keyboard ${randomUUID()}` } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: { name: "Keyboard Agent", role: "engineer", adapterType: "codex_local", adapterConfig: { model: "keyboard-1" }, runtimeConfig: { heartbeat: { enabled: false } } },
  }));
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: { title: "Keyboard draft", status: "backlog" } }));
  await page.route("**/api/instance/settings/experimental", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), enableClassicTaskInterface: false } });
  });
  await page.route(`**/api/companies/${company.id}/adapters/codex_local/models*`, (route) => route.fulfill({
    json: Array.from({ length: 8 }, (_, index) => ({ id: `keyboard-${index + 1}`, label: `Keyboard Model ${index + 1}` })),
  }));
  await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
  await page.getByRole("button", { name: "Select assignee, model and effort" }).tap();
  await page.getByRole("button", { name: "Choose assignee", exact: true }).tap();
  await keyboardHeight(page, 189);
  const dialog = page.getByTestId("composer-mobile-dialog");
  await insideKeyboardViewport(dialog);
  await insideKeyboardViewport(page.getByRole("listbox", { name: "Assignees" }));
  await page.getByRole("searchbox", { name: "Search assignees" }).fill("Keyboard Agent");
  await page.getByRole("option", { name: /Keyboard Agent/ }).tap();
  await page.getByRole("button", { name: "Choose exact model" }).tap();
  const list = page.getByRole("listbox", { name: "Models" });
  await insideKeyboardViewport(list);
  const last = list.getByRole("option", { name: /Keyboard Model 8/ });
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const rect = (await last.boundingBox())!;
    const bounds = (await list.boundingBox())!;
    if (rect.y + rect.height / 2 >= bounds.y && rect.y + rect.height / 2 <= bounds.y + bounds.height) break;
    await swipe(page, list);
  }
  // A row can be partially clipped at the list edge while its touch target is
  // reachable. Verify the actual hit target instead of requiring a whole row.
  await last.tap({ trial: true });
  await last.tap();
  await page.getByRole("button", { name: "Close picker" }).tap();
  await expect(page.getByTestId("task-chat-composer-model-label")).toHaveText("Keyboard Model 8");
  expect((await json(await request.get(`/api/issues/${issue.id}`))).assigneeAgentId).toBeNull();
  expect(agent.id).toBeTruthy();
});

test("new-task fields and actions remain reachable without overlap in a keyboard viewport", async ({ page, request, browserName }) => {
  test.skip(browserName !== "chromium", "Touch drags use Chromium input.");
  const company = await json(await request.post("/api/companies", { data: { name: `Task keyboard ${randomUUID()}` } }));
  // An agent avoids the empty-company onboarding screen in this layout test.
  await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: { name: "Draft Agent", role: "engineer", adapterType: "codex_local", runtimeConfig: { heartbeat: { enabled: false } } },
  }));
  await page.goto(`/${company.issuePrefix}/dashboard`);
  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "New Task", exact: true }).tap();
  const title = page.getByPlaceholder("Task title");
  await title.fill("Keep the keyboard draft");
  await keyboardHeight(page, 189);
  const dialog = page.getByRole("dialog").filter({ has: title });
  await insideKeyboardViewport(dialog);
  await title.scrollIntoViewIfNeeded();
  await insideKeyboardViewport(title);
  await page.getByRole("button", { name: "Assignee", exact: true }).tap();
  const picker = page.getByRole("dialog", { name: "Select assignee", exact: true });
  await insideKeyboardViewport(picker);
  await picker.getByRole("button", { name: "Close selector", exact: true }).tap();
  const description = dialog.locator('[contenteditable="true"]');
  await description.fill("A description that remains in the draft.");
  await swipe(page, dialog);
  const create = dialog.getByRole("button", { name: "Create Task", exact: true });
  await create.scrollIntoViewIfNeeded();
  await insideKeyboardViewport(create);
  // Trial checks hit testing without sending the task.
  await create.tap({ trial: true });
  await title.scrollIntoViewIfNeeded();
  await expect(title).toHaveValue("Keep the keyboard draft");
  await expect(description).toHaveText("A description that remains in the draft.");
  await keyboardHeight(page, 452);
  await page.setViewportSize({ width: 1280, height: 900 });
  await keyboardHeight(page, 900);
  await expect.poll(() => dialog.evaluate((el) => getComputedStyle(el).display)).toBe("flex");
  await expect(create).toBeVisible();
});
