import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LongCounter, OpenDeskRow, PhoneBank, Headset, CallQueueBoard,
  TerminalRack, CableTray, LawBookshelf, FileSafe, DocStamp,
  ArchiveWall, Carousel, WarMap, TokenMeter, KpiPanel,
} from "../furniture";

const all = [
  LongCounter, OpenDeskRow, PhoneBank, Headset, CallQueueBoard,
  TerminalRack, CableTray, LawBookshelf, FileSafe, DocStamp,
  ArchiveWall, Carousel, WarMap, TokenMeter, KpiPanel,
];

describe("new primitives", () => {
  it.each(all.map((C) => [C.name, C]))(
    "%s renders without throwing",
    (_name, Comp) => {
      const html = renderToStaticMarkup(
        <svg>
          <Comp x={0} y={0} />
        </svg>,
      );
      expect(html).toContain("<svg");
    },
  );
});
