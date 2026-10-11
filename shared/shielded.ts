// What the site says about receiving ZEC at a shielded Zcash address, in one place.
//
// The swap provider takes a unified Zcash address (u1...) as a receiving address, including one
// with no transparent part at all. That such a delivery arrives in a shielded pool has to be shown
// by a real swap before the site says it. Until then the server's setting ZEC_SHIELDED is
// "unproven", and the site says only what is known: the provider delivers to the address, and
// whether the coins arrive shielded is not confirmed. Once the setting is "proven", the
// sentences below that say so are shown, each in its place. None of them is shown before.
//
// The site never receives anyone's ZEC in order to shield it and send it on. Whatever is said
// here is about what the provider delivers, to the address the person gave.

import type { ZcashKind } from "./addresses.ts";

export type ZecShielded = "unproven" | "proven";

/** The setting as the page is told it. Anything but "proven" is "unproven". */
export function zecShieldedOf(config: { zecShielded?: unknown } | null | undefined): ZecShielded {
  return config?.zecShielded === "proven" ? "proven" : "unproven";
}

/** Said beside a unified receiving address while shielded delivery is not proven. It claims nothing. */
export const UNIFIED_UNPROVEN = "Delivered to this address. Not confirmed as shielded.";
/** Said beside a unified receiving address with no transparent part, once shielded delivery is proven. */
export const UNIFIED_SHIELDED_PROVEN = "ZEC is delivered to this shielded address.";
/** Said beside a unified receiving address that holds a transparent part, once shielded delivery is proven: what was proven is delivery to an address without one. */
export const UNIFIED_TRANSPARENT_PROVEN = "Has a transparent part: not confirmed as shielded.";
/** Said beside a unified address given as the refund address. What is known: the provider accepts it. Nothing is known of how a refund arrives. */
export const UNIFIED_REFUND = "Accepted for refunds. How one arrives is not confirmed.";

/**
 * The line under a Zcash address field for a valid address, or null where the field's ordinary
 * hint stands. Only a unified address has one: what a transparent or a TEX address receives is
 * public on Zcash, as it always was, and nothing new is said of it.
 */
export function zcashNote(kind: ZcashKind | null, use: "receive" | "refund", state: ZecShielded): string | null {
  if (kind !== "unified-shielded" && kind !== "unified-transparent") return null;
  if (use === "refund") return UNIFIED_REFUND;
  if (state !== "proven") return UNIFIED_UNPROVEN;
  return kind === "unified-shielded" ? UNIFIED_SHIELDED_PROVEN : UNIFIED_TRANSPARENT_PROVEN;
}

/** The home page's sentence. Shown only while the setting is "proven". */
export const SHIELDED_HOME = "Swap any coin and receive ZEC at a shielded Zcash address: a unified address with no transparent part.";

/** The Docs' sentences. Shown only while the setting is "proven". */
export const SHIELDED_DOCS: readonly string[] = [
  "ZEC can be delivered to a shielded Zcash address. Give a unified address (it starts with u1) that has no transparent part, and the provider delivers the ZEC to it in a shielded pool.",
  "This was confirmed with a real swap to such an address. A unified address that also holds a transparent part may be paid at that part, in public. SaplingDex never receives your ZEC to shield it: the provider delivers to the address you gave.",
];

/** The FAQ's question and answer. Shown only while the setting is "proven". */
export const SHIELDED_FAQ = {
  question: "Can I receive ZEC at a shielded address?",
  answer: "Yes. Choose ZEC on Zcash as the coin you receive and enter a unified address (it starts with u1) with no transparent part. The provider delivers the ZEC to it in a shielded pool. Addresses that start with zs1 are not supported.",
} as const;

/** Every sentence that says ZEC arrives shielded. None of these is on any page while the setting is "unproven" (a test holds each to it). */
export const SHIELDED_CLAIMS: readonly string[] = [UNIFIED_SHIELDED_PROVEN, SHIELDED_HOME, ...SHIELDED_DOCS, SHIELDED_FAQ.question, SHIELDED_FAQ.answer];
