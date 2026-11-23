// pinPlanGate.js — strictPins gating for the Pin Planner.
//
// With an untouched Pin Planner (no QSF, no assignments) the backend must be
// free to resolve board pins from port names (buzzerb→PIN_110, btn1→PIN_88,
// …).  strictPins=true would wipe that alias map and mute the whole board, so
// it is only sent when the user actually assigned pins.
//
// Note: exportPlannerToQsf() always emits a QSF header (FAMILY/DEVICE/
// TOP_LEVEL_ENTITY), so bare qsfText truthiness would ALWAYS be true and the
// gate would never open the auto-alias path.  Assignments are therefore
// detected by the validated count or by an actual set_location_assignment
// line in the generated QSF body.
const LOCATION_RE = /set_location_assignment\s+\S+\s+-to\s+\S+/;

export function pinPlanHasAssignments(pinPlan) {
    if ((pinPlan?.validation?.assignedCount || 0) > 0) return true;
    return LOCATION_RE.test(String(pinPlan?.qsfText || ""));
}
