import { describe, expect, it } from "vitest";
import {
  buildSubmission, formReducer, idempotencyKeyFor, initialFormState, type FormAction, type FormState,
} from "@/lib/assessment-draft";
import { TWO } from "./fixtures";

const run = (s: FormState, ...actions: FormAction[]) => actions.reduce(formReducer, s);
const scored = () => run(initialFormState(null),
  { type: "observe", value: "early" },
  { type: "answer", key: "taste", patch: { score: 4 } },
  { type: "answer", key: "hygiene", patch: { score: 5 } },
  { type: "qualityNotes", value: "Clean stall" });

describe("save state never claims newer edits are saved", () => {
  it("shows Saved only when the confirmed payload is what is on screen", () => {
    const s = run(scored(), { type: "start", payload: "p1", key: "k1" }, { type: "success", version: 1, replayed: false });
    expect(s.save).toBe("saved");
    expect(s.version).toBe(1);
  });

  it("an edit made while a save is in flight stays Unsaved after that save succeeds", () => {
    let s = run(scored(), { type: "start", payload: "p1", key: "k1" });
    s = formReducer(s, { type: "answer", key: "taste", patch: { score: 2 } }); // newer value
    expect(s.save).toBe("saving");
    s = formReducer(s, { type: "success", version: 1, replayed: false });
    expect(s.save).toBe("unsaved");
    expect(s.message).toMatch(/changed entries since/);
    expect(s.draft.taste.score).toBe(2);      // newer value kept for the next save
    expect(s.version).toBe(1);                // next save uses the confirmed version
  });

  it("a failure keeps the entries and reports failure, never Saved", () => {
    const s = run(scored(), { type: "start", payload: "p1", key: "k1" }, { type: "failure", message: "offline" });
    expect(s.save).toBe("failed");
    expect(s.draft.taste.score).toBe(4);
    expect(s.inFlight).toBeNull();
  });

  it("an identical retry reuses the idempotency key; changed data gets a new one", () => {
    const s = run(scored(), { type: "start", payload: "p1", key: "k1" }, { type: "failure", message: "lost" });
    expect(idempotencyKeyFor(s.key, "p1", () => "new")).toBe("k1");
    expect(idempotencyKeyFor(s.key, "p2", () => "new")).toBe("new");
  });
});

describe("absence and restoration", () => {
  it("sends only the absence note when absent, never quality scores or observations", () => {
    const s = run(scored(), { type: "observe", value: "absent" }, { type: "absenceNotes", value: "Stall closed" });
    const built = buildSubmission(s, TWO, false);
    expect(built).toEqual({ ok: true, body: { observed: "absent", answers: null, notes: "Stall closed", reason: null } });
  });

  it("after a confirmed absent save, returning to present requires fresh scores and empty observations", () => {
    let s = run(scored(), { type: "observe", value: "absent" }, { type: "absenceNotes", value: "Stall closed" },
      { type: "start", payload: "p", key: "k" }, { type: "success", version: 2, replayed: false });
    expect(s.draft).toEqual({});
    expect(s.qualityNotes).toBe("");
    s = formReducer(s, { type: "observe", value: "late" });
    const built = buildSubmission(s, TWO, false);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(Object.keys(built.errors)).toEqual(["taste", "hygiene"]);
  });

  it("quality observations never become the absence note and vice versa", () => {
    const s = run(scored(), { type: "observe", value: "absent" });
    expect(s.absenceNotes).toBe("");
    const back = run(s, { type: "absenceNotes", value: "Late notice" }, { type: "observe", value: "early" });
    expect(buildSubmission(back, TWO, false)).toMatchObject({ ok: true, body: { notes: "Clean stall" } });
  });

  it("loads a stored absent observation into the absence note only", () => {
    const s = initialFormState({ observed: "absent", answers: null, notes: null, absence_reason: "Ill", version: 3, state: "submitted" });
    expect([s.absenceNotes, s.qualityNotes, s.version]).toEqual(["Ill", "", 3]);
    expect(s.draft).toEqual({});
  });

  it("a cleared assessment starts empty but keeps its version for the stale check", () => {
    const s = initialFormState({ observed: "early", answers: { taste: 4, hygiene: 5 }, notes: "old", absence_reason: null, version: 4, state: "cleared" });
    expect([s.observed, s.qualityNotes, s.version]).toEqual(["", "", 4]);
    expect(s.draft).toEqual({});
  });

  it("an amendment needs a reason", () => {
    expect(buildSubmission(scored(), TWO, true)).toMatchObject({ ok: false, message: expect.stringMatching(/reason/) });
  });
});
