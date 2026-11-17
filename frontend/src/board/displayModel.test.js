import { describe, it, expect } from "vitest";
import {
    PERSISTENCE_MIN_HZ,
    brightness,
    ghostOverlay,
    isInstantaneousScan,
    normalizePov,
} from "./displayModel.js";

describe("displayModel", () => {
    it("classifies scan rates around the persistence threshold", () => {
        expect(isInstantaneousScan(1)).toBe(true);
        expect(isInstantaneousScan(15)).toBe(true);
        expect(isInstantaneousScan(59.9)).toBe(true);
        expect(isInstantaneousScan(60)).toBe(false);
        expect(isInstantaneousScan(763)).toBe(false);
        expect(isInstantaneousScan(0)).toBe(false);
        expect(PERSISTENCE_MIN_HZ).toBe(60);
    });

    it("keeps fractional duty (a 1-of-4 mux reads 0.25)", () => {
        const pov = normalizePov([0.25, 1, 0, 0], null);
        expect(pov[0]).toBeCloseTo(0.25, 5);
        expect(pov[1]).toBe(1);
        expect(pov[2]).toBe(0);
    });

    it("falls back to 0/1 bits for legacy images", () => {
        const pov = normalizePov([], [0, 1, 1, 0]);
        expect(Array.from(pov.slice(0, 4))).toEqual([0, 1, 1, 0]);
    });

    it("clamps out-of-range duty", () => {
        const pov = normalizePov([-1, 2]);
        expect(pov[0]).toBe(0);
        expect(pov[1]).toBe(1);
    });

    it("builds a per-segment ghost overlay, capped", () => {
        const overlay = ghostOverlay([
            [1, 0, 15.0, 0.25],
            [1, 2, 15.0, 0.1],
            [1, 2, 15.0, 0.9], // later sample wins by max, then clamps
            [9, 0, 1.0, 0.2],  // out of range ignored
        ]);
        expect(overlay[8]).toBeCloseTo(0.25, 5);
        expect(overlay[10]).toBeCloseTo(0.25, 5);
        expect(overlay[0]).toBe(0);
    });

    it("adds ghost bleed only while live, clamped to 1", () => {
        expect(brightness(0, 0.25, true)).toBeCloseTo(0.25, 5);
        expect(brightness(0, 0.25, false)).toBe(0);
        expect(brightness(0.9, 0.25, true)).toBe(1);
        expect(brightness(1.5, 0, true)).toBe(1);
        expect(brightness(Number.NaN, 0, true)).toBe(0);
    });
});