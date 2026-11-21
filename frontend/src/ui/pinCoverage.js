// pinCoverage.js — pure helper deciding whether a compiled design is
// missing its Pin Planner assignments (nothing mapped to board hardware).

/**
 * Returns a user-facing warning message when the compiled design has no pin
 * assignments at all, or null when at least one port is assigned (or when
 * there is nothing assignable — e.g. an empty interface).
 */
export function pinCoverageWarning(validation) {
    const v = validation || {};
    const assigned = Number(v.assignedCount ?? 0);
    const unassigned = Number(v.unassignedCount ?? 0);
    const assignable = assigned + unassigned;
    if (assignable > 0 && assigned === 0) {
        return "No pins assigned — this design is not mapped to any board hardware, "
            + "so nothing will light up or respond. Assign pins in the Pin Planner "
            + "(or apply board defaults).";
    }
    return null;
}
