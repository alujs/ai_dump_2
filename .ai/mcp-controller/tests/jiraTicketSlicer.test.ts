import test from "node:test";
import assert from "node:assert/strict";
import { sliceJiraTicket, toContextSignatureFields } from "../src/domains/connectors/jiraTicketSlicer";

test("sliceJiraTicket extracts core fields", () => {
  const raw = {
    key: "PROJ-123",
    fields: {
      issuetype: { name: "Story" },
      priority: { name: "High" },
      status: { name: "In Progress" },
      summary: "Add sdf-date-picker to KYC form",
      description: "Replace adp-date-picker with sdf-date-picker.\n\nAcceptance Criteria:\n- Date picker renders correctly\n- FormBuilder validators work\n- Shadow DOM styles applied",
      labels: ["migration", "sdf"],
      components: [{ name: "KYC Module" }, { name: "Shared Components" }],
      issuelinks: [
        { outwardIssue: { key: "PROJ-100" } },
        { inwardIssue: { key: "PROJ-50" } }
      ]
    }
  };

  const slice = sliceJiraTicket(raw);
  assert.equal(slice.issueKey, "PROJ-123");
  assert.equal(slice.issueType, "Story");
  assert.equal(slice.priority, "High");
  assert.equal(slice.status, "In Progress");
  assert.equal(slice.summary, "Add sdf-date-picker to KYC form");
  assert.deepStrictEqual(slice.labels, ["migration", "sdf"]);
  assert.deepStrictEqual(slice.components, ["KYC Module", "Shared Components"]);
  assert.deepStrictEqual(slice.linkedIssueKeys, ["PROJ-100", "PROJ-50"]);
});

test("sliceJiraTicket extracts acceptance criteria", () => {
  const raw = {
    key: "PROJ-456",
    fields: {
      issuetype: { name: "Task" },
      summary: "Test AC extraction",
      description: "Some context.\n\nAcceptance Criteria:\n- First criterion\n- Second criterion\n- Third criterion\n\nNotes:\nIgnore this",
      labels: [],
      components: []
    }
  };

  const slice = sliceJiraTicket(raw);
  assert.ok(slice.acceptanceCriteria.length >= 3, `Expected >= 3 AC, got ${slice.acceptanceCriteria.length}`);
  assert.ok(slice.acceptanceCriteria.includes("First criterion"));
  assert.ok(slice.acceptanceCriteria.includes("Second criterion"));
});

test("sliceJiraTicket extracts lexemes from code references", () => {
  const raw = {
    key: "PROJ-789",
    fields: {
      issuetype: { name: "Bug" },
      summary: "Fix `TransactionHistoryComponent` crash",
      description: "The component at `src/app/transactions/history.component.ts` throws when grid loads. The adp-table selector is deprecated.",
      labels: ["bug", "ag-grid"],
      components: [{ name: "Transactions" }]
    }
  };

  const slice = sliceJiraTicket(raw);
  assert.ok(slice.extractedLexemes.includes("transactionhistorycomponent"));
  assert.ok(slice.extractedLexemes.includes("src/app/transactions/history.component.ts"));
  assert.ok(slice.extractedLexemes.includes("adp-table"));
  assert.ok(slice.extractedLexemes.includes("bug"));
});

test("toContextSignatureFields returns correct shape", () => {
  const slice = sliceJiraTicket({
    key: "TEST-1",
    fields: {
      issuetype: { name: "Bug" },
      summary: "A bug",
      description: "Details",
      labels: ["urgent"],
      components: [{ name: "Core" }]
    }
  });

  const fields = toContextSignatureFields(slice);
  assert.equal(fields.issueType, "Bug");
  assert.deepStrictEqual(fields.labels, ["urgent"]);
  assert.deepStrictEqual(fields.components, ["Core"]);
  assert.equal(fields.summary, "A bug");
  assert.equal(fields.description, "Details");
});

test("sliceJiraTicket handles empty/missing fields gracefully", () => {
  const raw = { key: "EMPTY-1" };
  const slice = sliceJiraTicket(raw);
  assert.equal(slice.issueKey, "EMPTY-1");
  assert.equal(slice.issueType, "");
  assert.deepStrictEqual(slice.labels, []);
  assert.deepStrictEqual(slice.components, []);
  assert.deepStrictEqual(slice.acceptanceCriteria, []);
});
