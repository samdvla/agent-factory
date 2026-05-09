import propComputer from "../../assets/quaternius-scifi/Props_Computer.fbx?url";
import propComputerSmall from "../../assets/quaternius-scifi/Props_ComputerSmall.fbx?url";
import propCrate from "../../assets/quaternius-scifi/Props_Crate.fbx?url";
import propChest from "../../assets/quaternius-scifi/Props_Chest.fbx?url";
import propPod from "../../assets/quaternius-scifi/Props_Pod.fbx?url";
import propVesselShort from "../../assets/quaternius-scifi/Props_Vessel_Short.fbx?url";
import propVesselTall from "../../assets/quaternius-scifi/Props_Vessel_Tall.fbx?url";
import propShelfTall from "../../assets/quaternius-scifi/Props_Shelf_Tall.fbx?url";
import propLaser from "../../assets/quaternius-scifi/Props_Laser.fbx?url";
import propTeleporter1 from "../../assets/quaternius-scifi/Props_Teleporter_1.fbx?url";
import propContainerFull from "../../assets/quaternius-scifi/Props_ContainerFull.fbx?url";

export type PropPlacement = {
  url: string;
  position: [number, number, number]; // local to room (0..6 each axis)
  rotationY?: number;
  scale?: number;
};

// 3-5 props per kind. Adjust positions/scales after visual smoke test.
export const PROP_LAYOUTS: Record<string, PropPlacement[]> = {
  // Strategy Room — command bridge: pod (centerpiece holo emitter), 2 vessels (chairs)
  bridge: [
    { url: propPod, position: [3, 0, 3], rotationY: 0 },
    { url: propVesselShort, position: [1.8, 0, 4], rotationY: 0 },
    { url: propVesselShort, position: [4.2, 0, 4], rotationY: 0 },
  ],
  // Research Lab — dual computers + tall shelf
  analyst: [
    { url: propComputer, position: [2, 0, 3], rotationY: 0 },
    { url: propComputer, position: [4, 0, 3], rotationY: 0 },
    { url: propShelfTall, position: [1, 0, 5], rotationY: Math.PI / 2 },
  ],
  // Design Studio — small computer + crate + chest
  fab: [
    { url: propComputerSmall, position: [2, 0, 3], rotationY: 0 },
    { url: propCrate, position: [4, 0, 3.5], rotationY: 0 },
    { url: propChest, position: [4.5, 0, 5], rotationY: 0 },
  ],
  // Listing Desk — three small computers (broadcast) + container (outbox)
  dispatch: [
    { url: propComputerSmall, position: [1.5, 0, 3], rotationY: 0 },
    { url: propComputerSmall, position: [3, 0, 3], rotationY: 0 },
    { url: propComputerSmall, position: [4.5, 0, 3], rotationY: 0 },
    { url: propContainerFull, position: [3, 0, 5], rotationY: 0 },
  ],
  // CS Booth — single workstation
  comms: [
    { url: propComputer, position: [3, 0, 3], rotationY: 0 },
    { url: propVesselShort, position: [3, 0, 4.2], rotationY: 0 },
  ],
  // Finance Office — large computer + 2 crates (records)
  control: [
    { url: propComputer, position: [3, 0, 3], rotationY: 0 },
    { url: propCrate, position: [1.5, 0, 5], rotationY: 0 },
    { url: propCrate, position: [4.5, 0, 5], rotationY: 0 },
  ],
  // SI Lab — laser (experimental rig) + teleporter + computer
  rd: [
    { url: propLaser, position: [2, 0, 3], rotationY: 0 },
    { url: propTeleporter1, position: [4, 0, 3], rotationY: 0 },
    { url: propComputer, position: [3, 0, 5], rotationY: 0 },
  ],
};

// Suppress unused import warnings — vesselTall is available for future use
void propVesselTall;
