// The first words of the site, in one place: its headline, its title, and the one sentence a
// search result or a link preview shows. There are two sets, because the site says what the server
// does. Where swaps are routed privately (the server's PRIVACY_MODE is "basic") it says so. Where
// they are routed in public it reads as it always has, and says nothing of private swaps.
//
// The page itself holds the public set (web/index.html). The server writes the private set into
// the page it serves where private routing is in force (server/static.ts), and the headline's own
// component draws whichever applies (web/src/components/Home.tsx). Tests hold all three to this file.

export type SiteMode = "public" | "private";

export interface Positioning {
  /** The page's title: a browser's tab, a bookmark, a link preview. */
  title: string;
  /** One sentence for a search result or a link preview. */
  description: string;
  /** The headline: its opening words, and the words after them, which are drawn in the accent colour. */
  headline: { plain: string; accent: string };
  /** The image a link to the site is shown with, by its address on the site. */
  shareImage: string;
}

export const POSITIONING: Readonly<Record<SiteMode, Positioning>> = {
  public: {
    title: "SaplingDex",
    description: "Swap any coin on any chain to ZEC on Solana, and back.",
    headline: { plain: "Any coin, in and out of ZEC.", accent: "Powered by NEAR Intents." },
    shareImage: "/share.png",
  },
  private: {
    title: "SaplingDex: private swaps, in and out of ZEC",
    description: "Private swaps across chains, in and out of ZEC on Solana. Powered by NEAR Intents.",
    headline: { plain: "Private swaps, in and out of ZEC.", accent: "Powered by NEAR Intents." },
    shareImage: "/share-private.png",
  },
};

/**
 * Said in the footer of every page, on the token's page and at the top of the Docs, in these words:
 * the site has "Sapling" in its name and looks at home beside it, so it says plainly that it is not Sapling's.
 */
export const INDEPENDENCE = "SaplingDex is an independent project and is not affiliated with or endorsed by Sapling, the Zcash Foundation, Electric Coin Co. or NEAR.";

/** The sentence under the headline. It is the same in both. */
export const HEADLINE_SUB = "Bring any coin from any chain and arrive on Solana with ZEC, or take ZEC out to any coin. Every fee is shown before you confirm.";

/** The headline word by word, in the order the words come up, each with whether it is drawn in the accent colour. */
export function headlineWords(mode: SiteMode): { text: string; accent: boolean }[] {
  const { plain, accent } = POSITIONING[mode].headline;
  return [...plain.split(" ").map((text) => ({ text, accent: false })), ...accent.split(" ").map((text) => ({ text, accent: true }))];
}

/** What the share image says, for someone who cannot see it. */
export function shareImageAlt(mode: SiteMode): string {
  return `SaplingDex. ${POSITIONING[mode].description}`;
}
