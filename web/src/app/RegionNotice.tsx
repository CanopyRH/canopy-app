import { Info } from "lucide-react";
import { REGION_NOTICE } from "../copy/text";
import type { RegionKind } from "../region";

/** A calm note for features that may be restricted where the reader lives. It reads no location and blocks nothing. */
export default function RegionNotice({ kind }: { kind: RegionKind }) {
  return <aside className="cd-region-notice" role="note" aria-label={REGION_NOTICE.title}><Info size={16} aria-hidden="true" /><p><strong>{REGION_NOTICE.title}.</strong> {REGION_NOTICE[kind]}</p></aside>;
}
