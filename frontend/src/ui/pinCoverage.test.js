import { describe, it, expect } from "vitest";
import { pinCoverageWarning } from "./pinCoverage.js";

describe("pinCoverageWarning", () => {
    it("warns when nothing is assigned", () => {
        const msg = pinCoverageWarning({ assignedCount: 0, unassignedCount: 21 });
        expect(msg).toContain("No pins assigned");
        expect(msg).toContain("Pin Planner");
    });

    it("stays silent when at least one port is assigned", () => {
        expect(pinCoverageWarning({ assignedCount: 3, unassignedCount: 18 })).toBeNull();
    });

    it("stays silent when everything is assigned", () => {
        expect(pinCoverageWarning({ assignedCount: 21, unassignedCount: 0 })).toBeNull();
    });

    it("treats a missing validation as nothing to warn about", () => {
        expect(pinCoverageWarning(null)).toBeNull();
        expect(pinCoverageWarning({})).toBeNull();
    });
});
