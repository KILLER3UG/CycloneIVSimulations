// editableGuard.js — pure DOM focus guard for global keyboard shortcuts.
//
// Global shortcuts (1–4 KEY hold, R reset, arrows…) must never fire while
// the user is typing inside an editable element: text inputs, textareas,
// selects, contenteditable hosts and the Monaco/CodeMirror editor surface.

const EDITOR_SELECTOR = ".monaco-editor, .cm-editor, .CodeMirror";

export function isEditableTarget(target) {
    if (!target || typeof target.closest !== "function") return false;
    if (target.isContentEditable === true) return true;
    const tag = String(target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return Boolean(target.closest(`input, textarea, select, [contenteditable="true"], [contenteditable=""], ${EDITOR_SELECTOR}`));
}
