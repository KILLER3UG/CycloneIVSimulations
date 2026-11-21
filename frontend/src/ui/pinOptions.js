// pinOptions.js — pure filter for Pin Planner dropdown options.

/**
 * Catalog entries still assignable by a row: every catalog pin except the
 * ones already taken by other ports. The row's own pin always stays in the
 * list so its current value remains a valid choice.
 *
 * @param {Array<{pin: string}>} catalogList
 * @param {Iterable<string>} takenPins  pins assigned to other ports
 * @param {string|null} ownPin          this row's current pin (kept)
 */
export function allowedPinOptions(catalogList, takenPins, ownPin) {
    const taken = new Set([...(takenPins || [])].map((p) => String(p || "").toUpperCase()));
    const own = String(ownPin || "").toUpperCase();
    return (catalogList || []).filter((c) => {
        const pin = String(c?.pin || "").toUpperCase();
        return !taken.has(pin) || pin === own;
    });
}
