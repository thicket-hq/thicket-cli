import { describe, expect, it } from "vitest";
import { parseThicketUrl, recordingPath, recordingUrl } from "../src/lib/urls.js";

const ORG = "acme";
const P = "1e6b3cbb-0000-4000-8000-000000000001";
const A = "1e6b3cbb-0000-4000-8000-00000000000a";
const B = "1e6b3cbb-0000-4000-8000-00000000000b";
const HOST = "https://www.thickethq.com";

describe("parseThicketUrl", () => {
  it("rejects non-app URLs", () => {
    expect(parseThicketUrl("https://example.com/x")).toBeNull();
    expect(parseThicketUrl("not a url")).toBeNull();
  });

  it("reads every project tool shape the app builds", () => {
    const cases: [string, string, string | null, string | null][] = [
      [`/projects/${P}/message-board/${A}`, "message", A, null],
      [`/projects/${P}/message-board`, "message_board", null, null],
      [`/projects/${P}/docs/${A}`, "document", A, null],
      [`/projects/${P}/docs/files/${A}`, "upload", A, null],
      [`/projects/${P}/docs/links/${A}`, "linked_file", A, null],
      [`/projects/${P}/todos/${A}`, "todolist", A, null],
      [`/projects/${P}/todos/${A}/${B}`, "todo", B, A],
      [`/projects/${P}/todos/progress/${A}`, "progress_update", A, null],
      [`/projects/${P}/health/${A}`, "health_update", A, null],
      [`/projects/${P}/timesheet/${A}`, "timesheet", A, null],
      [`/projects/${P}/calendar/${A}`, "calendar_event", A, null],
      [`/projects/${P}/cards/${A}`, "card", A, null],
      [`/projects/${P}/cards/columns/${A}`, "column", A, null],
      [`/projects/${P}/chat`, "chat", null, null],
      [`/projects/${P}/check-ins/${A}`, "question", A, null],
      [`/projects/${P}/check-ins/${A}/answers/${B}`, "answer", B, A],
      [`/projects/${P}/clients/approvals/${A}`, "client_approval", A, null],
      [`/projects/${P}/clients/correspondence/${A}`, "client_correspondence", A, null],
    ];
    for (const [path, type, recordingId, parentId] of cases) {
      const parsed = parseThicketUrl(`${HOST}/o/${ORG}${path}`);
      expect(parsed, path).not.toBeNull();
      expect(parsed!.org).toBe(ORG);
      expect(parsed!.project_id).toBe(P);
      expect(parsed!.type, path).toBe(type);
      expect(parsed!.recording_id, path).toBe(recordingId);
      expect(parsed!.parent_id, path).toBe(parentId);
    }
  });

  it("reads account-level pages, comment fragments, and bare paths", () => {
    expect(parseThicketUrl(`${HOST}/o/${ORG}/calendar/${A}`)).toMatchObject({ type: "calendar_event", recording_id: A, project_id: null });
    expect(parseThicketUrl(`${HOST}/o/${ORG}/chats/${A}`)).toMatchObject({ type: "dm", recording_id: A });
    expect(parseThicketUrl(`${HOST}/o/${ORG}/projects/${P}/cards/${A}?x=1#comment-${B}`)).toMatchObject({ recording_id: A, comment_id: B });
    expect(parseThicketUrl(`/o/${ORG}/projects/${P}/todos/${A}/${B}#comment-${A}`)).toMatchObject({ recording_id: B, comment_id: A });
    expect(parseThicketUrl(`http://localhost:3003/o/${ORG}/projects/${P}`)).toMatchObject({ project_id: P, recording_id: null, type: null });
  });

  it("reads a repeating event's day and the project's timesheet page", () => {
    expect(parseThicketUrl(`${HOST}/o/${ORG}/projects/${P}/calendar/${A}?occurrence=2026-09-22`)).toMatchObject({ type: "calendar_event", recording_id: A, occurrence: "2026-09-22" });
    expect(parseThicketUrl(`/o/${ORG}/calendar/${A}?occurrence=2026-09-22#comment-${B}`)).toMatchObject({ recording_id: A, occurrence: "2026-09-22", comment_id: B });
    expect(parseThicketUrl(`${HOST}/o/${ORG}/projects/${P}/calendar/${A}?occurrence=soon`)?.occurrence).toBeNull();
    expect(parseThicketUrl(`${HOST}/o/${ORG}/projects/${P}/cards/${A}`)?.occurrence).toBeNull();
    expect(parseThicketUrl(`${HOST}/o/${ORG}/projects/${P}/timesheet`)).toMatchObject({ project_id: P, type: "timesheet", recording_id: null });
    expect(recordingPath(ORG, { id: A, type: "timesheet", project_id: P })).toBe(`/o/${ORG}/projects/${P}/timesheet`);
  });

  it("round-trips through recordingPath for every type", () => {
    const types = [
      "message", "document", "upload", "linked_file", "todolist", "todo", "progress_update", "health_update",
      "calendar_event", "card", "column", "question", "answer", "client_approval", "client_correspondence",
    ];
    for (const type of types) {
      const needsParent = type === "todo" || type === "answer";
      const path = recordingPath(ORG, { id: A, type, project_id: P, parent_id: needsParent ? B : null });
      const parsed = parseThicketUrl(`${HOST}${path}`);
      expect(parsed?.type, type).toBe(type);
      expect(parsed?.recording_id, type).toBe(A);
      if (needsParent) expect(parsed?.parent_id).toBe(B);
    }
    expect(recordingUrl(`${HOST}/`, ORG, { id: A, type: "calendar_event", project_id: null })).toBe(`${HOST}/o/${ORG}/calendar/${A}`);
    expect(recordingPath(ORG, { id: A, type: "chat_message", project_id: P, parent_id: B })).toBe(`/o/${ORG}/projects/${P}/chat`);
    expect(recordingPath(ORG, { id: A, type: "dm", project_id: null })).toBe(`/o/${ORG}/chats/${A}`);
  });
});
