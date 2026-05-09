import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WALL_FEATURES } from "../wallFeatures";
import type { WallFeature } from "../../../state/types";

const tags: WallFeature[] = [
  "kanban", "trends", "moodboard", "ledger", "logwall",
  "chatwall", "warmap", "datafeed", "archive", "docs",
];

describe("wall features", () => {
  it.each(tags)("%s renders without throwing", (tag) => {
    const Comp = WALL_FEATURES[tag];
    const html = renderToStaticMarkup(
      <svg>
        <Comp ox={0} oy={0} accent="#5fd4f0" />
      </svg>,
    );
    expect(html).toContain("<svg");
  });
});
