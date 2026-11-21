import { describe, it, expect } from "vitest";
import { allowedPinOptions } from "./pinOptions.js";

const CATALOG = [
    { pin: "PIN_23", label: "CLOCK_50" },
    { pin: "PIN_87", label: "LED0" },
    { pin: "PIN_86", label: "LED1" },
    { pin: "PIN_88", label: "KEY0" },
];

describe("allowedPinOptions", () => {
    it("keeps every pin when nothing is taken", () => {
        const out = allowedPinOptions(CATALOG, [], null);
        expect(out.map((o) => o.pin)).toEqual(["PIN_23", "PIN_87", "PIN_86", "PIN_88"]);
    });

    it("hides pins assigned to other ports", () => {
        const out = allowedPinOptions(CATALOG, ["PIN_87", "PIN_23"], null);
        expect(out.map((o) => o.pin)).toEqual(["PIN_86", "PIN_88"]);
    });

    it("keeps the row's own assignment selectable", () => {
        const out = allowedPinOptions(CATALOG, ["PIN_87"], "PIN_87");
        expect(out.map((o) => o.pin)).toEqual(["PIN_23", "PIN_87", "PIN_86", "PIN_88"]);
    });

    it("is case-insensitive about taken and own pins", () => {
        const out = allowedPinOptions(CATALOG, ["pin_87"], "pin_86");
        expect(out.map((o) => o.pin)).toEqual(["PIN_23", "PIN_86", "PIN_88"]);
    });

    it("handles an empty catalog", () => {
        expect(allowedPinOptions([], [], null)).toEqual([]);
    });
});
