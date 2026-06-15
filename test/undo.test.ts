import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/createProject";
import { serializeProject } from "../src/core/serialize";
import type { Project } from "../src/core/schema";
import {
  emptyStack,
  pushCommand,
  redo,
  undo,
  type Command,
} from "../src/editor/commands";

function variant(base: Project, name: string): Project {
  // immutable update（meta.name を変える）
  return { ...base, meta: { ...base.meta, name } };
}

describe("Undo/Redo stack (§17 snapshot)", () => {
  it("undo restores the previous snapshot, redo re-applies", () => {
    const v0 = createProject({ name: "v0", now: "2026-01-01T00:00:00.000Z" });
    const v1 = variant(v0, "v1");
    const v2 = variant(v1, "v2");

    let stack = emptyStack();
    stack = pushCommand(stack, { label: "→v1", before: v0, after: v1 } satisfies Command);
    stack = pushCommand(stack, { label: "→v2", before: v1, after: v2 } satisfies Command);

    // undo → v1
    const u1 = undo(stack)!;
    expect(u1.project.meta.name).toBe("v1");
    // undo → v0
    const u2 = undo(u1.stack)!;
    expect(u2.project.meta.name).toBe("v0");
    // redo → v1
    const r1 = redo(u2.stack)!;
    expect(r1.project.meta.name).toBe("v1");
  });

  it("undo at the bottom of the stack returns null", () => {
    expect(undo(emptyStack())).toBeNull();
    expect(redo(emptyStack())).toBeNull();
  });

  it("a new command after undo clears the redo (future) stack", () => {
    const v0 = createProject({ name: "v0", now: "2026-01-01T00:00:00.000Z" });
    const v1 = variant(v0, "v1");
    const v2b = variant(v0, "v2b");

    let stack = pushCommand(emptyStack(), { label: "→v1", before: v0, after: v1 });
    const u = undo(stack)!; // back to v0, v1 in future
    expect(u.stack.future.length).toBe(1);
    stack = pushCommand(u.stack, { label: "→v2b", before: v0, after: v2b });
    expect(stack.future.length).toBe(0); // future cleared
  });

  it("snapshots are independent: undoing does not carry later edits (immutability)", () => {
    const v0 = createProject({ name: "v0", now: "2026-01-01T00:00:00.000Z" });
    const canonical0 = serializeProject(v0);
    const v1 = variant(v0, "v1");

    const stack = pushCommand(emptyStack(), { label: "→v1", before: v0, after: v1 });
    const u = undo(stack)!;
    // 復元された v0 は元の canonical と byte 等価（v1 の変更が漏れていない）
    expect(serializeProject(u.project)).toBe(canonical0);
  });
});
