import { describe, it, expect } from "vitest";
import { ROOMS, ROLES, FOUNDING_HIRE_EVENTS } from "../fixtures";

describe("founding fixtures", () => {
  it("every founding room has a kit", () => {
    for (const id of Object.keys(ROOMS)) {
      expect(ROOMS[id].kit).toBeDefined();
    }
  });

  it("CS Booth has comms tag and capacity 4", () => {
    expect(ROOMS.cs.kit?.primaryTag).toBe("comms");
    expect(ROOMS.cs.kit?.capacity).toBe(4);
  });

  it("Listing Desk has copy tag and capacity 2", () => {
    expect(ROOMS.listing.kit?.primaryTag).toBe("copy");
    expect(ROOMS.listing.kit?.capacity).toBe(2);
  });

  it("every founding role is permanent", () => {
    for (const id of Object.keys(ROLES)) {
      expect(ROLES[id].permanent).toBe(true);
    }
  });

  it("FOUNDING_HIRE_EVENTS covers every founding role with reason=founding", () => {
    // 9 founding office roles + 7 designer-wing specialists. The exact count
    // is bumped here intentionally so the test catches accidental additions
    // — when a real new founding role lands, update this number on purpose.
    expect(FOUNDING_HIRE_EVENTS).toHaveLength(16);
    for (const e of FOUNDING_HIRE_EVENTS) {
      expect(e.justification.reason).toBe("founding");
    }
  });

  it("every designer-wing specialist room renders with a kit and one occupant", () => {
    const specialistIds = [
      "anime", "hero", "mecha", "chibi", "deity", "creature", "humanoid",
    ];
    for (const id of specialistIds) {
      expect(ROOMS[id], `room ${id} missing`).toBeDefined();
      expect(ROOMS[id].kit, `room ${id} missing kit`).toBeDefined();
      expect(ROOMS[id].kit?.capacity).toBe(1);
      expect((ROOMS[id].occupants ?? []).length).toBe(1);
    }
  });
});
