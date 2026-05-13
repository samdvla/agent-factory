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

  it("FOUNDING_HIRE_EVENTS has 9 entries with reason=founding", () => {
    expect(FOUNDING_HIRE_EVENTS).toHaveLength(9);
    for (const e of FOUNDING_HIRE_EVENTS) {
      expect(e.justification.reason).toBe("founding");
    }
  });
});
