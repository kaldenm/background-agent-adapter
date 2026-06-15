import { expect, test } from "@playwright/test";
import {
  mockAuthenticatedApp,
  mockSessionWebSocketWithDaytonaFailure,
  mockSessionWebSocketWithAgentReply,
  mockUnauthenticatedApp,
} from "./fixtures";

test("signed-out users see the GitHub sign-in screen", async ({ page }) => {
  await mockUnauthenticatedApp(page);

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Open-Inspect" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
});

test("authenticated users can create a session from the home prompt", async ({ page }) => {
  await mockAuthenticatedApp(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to Open-Inspect" })).toBeVisible();
  await expect(page.getByText("web-app")).toBeVisible();

  await page.getByPlaceholder("What do you want to build?").fill("Fix the checkout retry bug");
  await page.getByRole("button", { name: /send/i }).click();

  await expect(page).toHaveURL(/\/session\/session-e2e-new/);
});

test("users can archive a session from the session page action bar", async ({ page }) => {
  await mockAuthenticatedApp(page);

  await page.goto(
    "/session/session-e2e-active?repoOwner=acme&repoName=web-app&title=Fix%20checkout"
  );
  await page.getByRole("button", { name: "Archive" }).click();
  await page.getByRole("button", { name: "Archive" }).click();

  await expect(page).toHaveURL(/\/$/);
});

test("users can see an agent response in a session", async ({ page }) => {
  await mockAuthenticatedApp(page);
  await mockSessionWebSocketWithAgentReply(page);

  await page.goto(
    "/session/session-e2e-active?repoOwner=acme&repoName=web-app&title=Fix%20checkout"
  );

  await expect(page.getByText("You", { exact: true })).toBeVisible();
  await expect(page.getByText("Fix the checkout retry bug")).toBeVisible();
  await expect(page.getByText("Assistant", { exact: true })).toBeVisible();
  await expect(
    page.getByText("I found the retry handler and added a failing regression test.")
  ).toBeVisible();
  await expect(page.getByText("Execution complete")).toBeVisible();
});

test("users can see the Daytona sandbox creation failure reason", async ({ page }) => {
  await mockAuthenticatedApp(page);
  await mockSessionWebSocketWithDaytonaFailure(page);

  await page.goto(
    "/session/session-e2e-active?repoOwner=acme&repoName=web-app&title=Fix%20checkout"
  );

  await expect(page.getByText("Sandbox: failed")).toBeVisible();
  await expect(page.getByText("Sandbox creation failed")).toBeVisible();
  await expect(page.getByText(/Invalid credentials/)).toBeVisible();
});

test("users can delete an archived session from data controls", async ({ page }) => {
  await mockAuthenticatedApp(page);

  await page.goto("/settings?tab=data-controls");
  await expect(page.getByText("Archived cleanup target")).toBeVisible();

  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  await expect(page.getByText("Archived cleanup target")).toBeHidden();
  await expect(page.getByText("No archived sessions", { exact: true })).toBeVisible();
});

test("users can save an Anthropic API key without Claude Code OAuth", async ({ page }) => {
  await mockAuthenticatedApp(page);

  await page.goto("/settings/integrations/anthropic");

  await expect(page.getByRole("button", { name: "Connect with Anthropic" })).toBeHidden();
  await page.getByPlaceholder("sk-ant-...").fill("sk-ant-e2e");
  await expect(page.getByText("Unsaved API key entered")).toBeVisible();
  await expect(page.getByText("No API key saved")).toBeHidden();
  await page.getByRole("button", { name: "Save entered key" }).click();

  await expect(page.getByText("API key connected")).toBeVisible();
});

test("users can complete the Anthropic OAuth paste-code flow without live credentials", async ({
  page,
}) => {
  await mockAuthenticatedApp(page);

  await page.goto("/settings/integrations/anthropic");
  await page.getByText("Advanced: Claude Code OAuth").click();

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect with Anthropic" }).click();
  const popup = await popupPromise;
  expect(popup.url()).toContain("https://claude.ai/oauth/authorize");
  await popup.close();

  await page.getByPlaceholder("Paste code from Anthropic here…").fill("mock-auth-code");
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page.getByText("Claude Code connected")).toBeVisible();
});
