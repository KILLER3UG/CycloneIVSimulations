import { describe, expect, it } from "vitest";
import { pinPlanHasAssignments } from "./pinPlanGate.js";
import { exportPlannerToQsf, parseEntitiesWithPorts } from "./pinPlanner.js";

describe("pinPlanHasAssignments", () => {
    it("is false for an untouched/empty Pin Planner", () => {
        expect(pinPlanHasAssignments(null)).toBe(false);
        expect(pinPlanHasAssignments(undefined)).toBe(false);
        expect(pinPlanHasAssignments({})).toBe(false);
        expect(pinPlanHasAssignments({ qsfText: "", validation: { assignedCount: 0 } })).toBe(false);
        expect(pinPlanHasAssignments({ qsfText: "  " })).toBe(false);
    });

    it("is false for the header-only QSF a fresh planner produces", () => {
        // exportPlannerToQsf always emits a header even with zero assignments;
        // the gate must see through it (this is the exact empty-planner bug).
        const [ent] = parseEntitiesWithPorts(
            `entity demo is port (clk : in bit; led : out bit); end entity demo;`,
            "demo.vhd",
        );
        const qsfText = exportPlannerToQsf("demo", [{ nodeName: "clk", portName: "clk", width: 1 }], {}, "EP4CE6E22C8");
        expect(qsfText).toContain("set_global_assignment");
        expect(qsfText).not.toContain("set_location_assignment");
        expect(pinPlanHasAssignments({ qsfText, validation: { assignedCount: 0 } })).toBe(false);
    });

    it("is true when a QSF body carries location assignments", () => {
        expect(pinPlanHasAssignments({
            qsfText: "set_location_assignment PIN_110 -to buzzerb",
        })).toBe(true);
        expect(pinPlanHasAssignments({
            qsfText: [
                `set_global_assignment -name FAMILY "Cyclone IV E"`,
                "set_location_assignment PIN_88 -to btn1",
                'set_instance_assignment -name IO_STANDARD "3.3-V LVTTL" -to btn1',
            ].join("\n"),
        })).toBe(true);
    });

    it("is true when the planner validated assignments", () => {
        expect(pinPlanHasAssignments({ validation: { assignedCount: 3 } })).toBe(true);
    });
});
