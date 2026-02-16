import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/types";
import { validateGatewayConfig } from "../src/config/validateConfig";

test("config validator rejects blocked dashboard ports", () => {
  const config = {
    ...DEFAULT_CONFIG,
    dashboardPort: 4200
  };
  const result = validateGatewayConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes("must not be 4200 or 8080")));
});

test("config validator enforces jira pat path scope", () => {
  const config = {
    ...DEFAULT_CONFIG,
    jira: {
      ...DEFAULT_CONFIG.jira,
      patFilePath: "tmp/jira.token"
    }
  };
  const result = validateGatewayConfig(config);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes(".ai/auth")));
});
