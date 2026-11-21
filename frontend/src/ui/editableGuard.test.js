import { describe, it, expect } from "vitest";
import { isEditableTarget } from "./editableGuard.js";

function fakeTarget({ tagName = "DIV", matches = [], contentEditable = false } = {}) {
    return {
        tagName,
        isContentEditable: contentEditable,
        // mimic Element.closest: the guard passes one combined selector
        closest: (sel) => {
            const hit = matches.find((m) => sel.includes(m));
            return hit ? { matched: hit } : null;
        },
    };
}

describe("isEditableTarget", () => {
    it("ignores plain elements", () => {
        expect(isEditableTarget(fakeTarget())).toBe(false);
    });

    it("guards form fields by tag name", () => {
        for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
            expect(isEditableTarget(fakeTarget({ tagName: tag }))).toBe(true);
        }
    });

    it("guards contenteditable hosts", () => {
        expect(isEditableTarget(fakeTarget({ contentEditable: true }))).toBe(true);
    });

    it("guards the Monaco/CodeMirror editor surface", () => {
        expect(isEditableTarget(fakeTarget({ matches: [".monaco-editor"] }))).toBe(true);
        expect(isEditableTarget(fakeTarget({ matches: [".cm-editor"] }))).toBe(true);
        expect(isEditableTarget(fakeTarget({ matches: [".CodeMirror"] }))).toBe(true);
    });

    it("guards nested elements inside editables", () => {
        expect(isEditableTarget(fakeTarget({ matches: ["input"] }))).toBe(true);
        expect(isEditableTarget(fakeTarget({ matches: ['[contenteditable="true"]'] }))).toBe(true);
    });

    it("handles missing targets", () => {
        expect(isEditableTarget(null)).toBe(false);
        expect(isEditableTarget(undefined)).toBe(false);
        expect(isEditableTarget({})).toBe(false);
    });
});
