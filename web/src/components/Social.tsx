// The places SaplingDex is found elsewhere, as icon links: GitHub and X, in that order. They stand
// in the header on a wide screen, in the menu on a phone, and in the footer. Where each leads is a
// setting on the server. While one is not set its icon is not there, and with neither set there is
// no row at all.

import type { ReactNode } from "react";
import { socialLinks, type SocialKey } from "../lib/site-logic.ts";
import { useApp } from "../stores/app.ts";
import { OutboundLink } from "./OutboundLink.tsx";

/**
 * Each mark in one colour (the colour of the text around it), drawn in the same 20 px box and
 * balanced by eye so that neither looks larger than the other: a mark that fills its box to the
 * corners (X) is drawn a little smaller than a round one (GitHub). The X and GitHub marks are the
 * ones those services publish, as redrawn for the Simple Icons set (CC0).
 */
export const SOCIAL_MARKS: Record<SocialKey, ReactNode> = {
  github: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  ),
  x: (
    <svg viewBox="-2.5 -2.5 29 29" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
    </svg>
  ),
};

/** The icons in a row. `where` only names the row for a stylesheet; the icons are the same everywhere. */
export function SocialLinks({ where }: { where: "header" | "menu" | "footer" }) {
  const config = useApp((state) => state.config);
  const links = socialLinks(config);
  if (links.length === 0) return null;
  return (
    <ul className="social" data-where={where}>
      {links.map((link) => (
        <li key={link.key}>
          {/* A link out like any other on the site: a new tab, and the other site told nothing (see OutboundLink). */}
          <OutboundLink className="social-link" href={link.href} aria-label={link.label} title={link.label}>
            {SOCIAL_MARKS[link.key]}
          </OutboundLink>
        </li>
      ))}
    </ul>
  );
}
