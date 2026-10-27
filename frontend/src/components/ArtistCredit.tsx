import { Fragment } from "react";
import type { To } from "react-router";
import RouteLink from "./RouteLink";
import { resolveArtistPath } from "../navigation/resolveLinks.ts";
import type {
  ArtistCredit as ArtistCreditValue,
  ArtistCreditEntry,
} from "../../../lib/artistCredit.ts";

export const artistCreditPath = (entry: ArtistCreditEntry): To | null =>
  entry.mbid ? `/artist/${entry.mbid}` : resolveArtistPath({ name: entry.name });

export function ArtistCredit({
  credit,
  className,
  linkClassName,
  linkFor = artistCreditPath,
}: {
  credit: ArtistCreditValue;
  className?: string;
  linkClassName?: string;
  linkFor?: (entry: ArtistCreditEntry) => To | null;
}) {
  return (
    <span className={className}>
      {credit.map((entry, index) => {
        const to = linkFor(entry);
        return (
          <Fragment key={`${index}:${entry.mbid || entry.name}`}>
            {to ? (
              <RouteLink to={to} className={linkClassName}>
                {entry.name}
              </RouteLink>
            ) : (
              entry.name
            )}
            {entry.joinPhrase}
          </Fragment>
        );
      })}
    </span>
  );
}
