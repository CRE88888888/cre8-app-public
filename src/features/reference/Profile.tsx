import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ReferenceSheet } from "./ReferenceSheet";
import { attachFundProfiles } from "../../reference/lib/fund-profile";
import { normalizeXHandle, xProfileUrl } from "../../reference/lib/x-profile";
import { REFERENCE_METADATA } from "../../lib/public-funds";
import type { ReferenceFund } from "../../lib/public-funds";
export function XLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.3l8.2-9.5L.8 2h6.5l4.5 6.8L18.9 2ZM17.8 20h1.7L6.4 3.9H4.6L17.8 20Z"
      />
    </svg>
  );
}
export function FundPortrait({
  fund,
  url,
}: {
  fund: ReferenceFund;
  url?: string;
}) {
  const root = useRef<HTMLSpanElement>(null),
    card = useRef<HTMLElement>(null),
    id = useId(),
    meta = REFERENCE_METADATA[fund.slug];
  useEffect(() => {
    if (!root.current || !card.current || !meta.profile) return;
    const binding = attachFundProfiles(root.current, card.current, () => ({
      profile: meta.profile!,
      image: meta.cover.thumbnailSrc,
    }));
    return () => binding.abort();
  }, [meta]);
  const image = (
    <>
      <img
        src={meta.cover.thumbnailSrc}
        alt=""
        width="88"
        height="88"
        loading="lazy"
        style={{ objectPosition: `50% ${meta.cover.thumbnailPosition}%` }}
      />

    </>
  );
  return (
    <span ref={root} className="public-portrait">
      {meta.profile ? (
        <button
          type="button"
          className="fund-thumb fund-profile-trigger"
          data-fund-profile={fund.slug}
          aria-label={`About ${meta.profile.name}`}
          aria-haspopup="dialog"
          aria-controls={id}
        >
          {image}
        </button>
      ) : (
        <Link className="fund-thumb" to={url || `/funds/${fund.slug}`}>
          {image}
        </Link>
      )}
      {fund.group === "x-voices" && (
        <span className="fund-x-badge" aria-hidden="true">
          <XLogo />
        </span>
      )}
      <aside
        ref={card}
        id={id}
        className="fund-profile-card"
        popover="manual"
        role="dialog"
        aria-label="Person introduction"
      />
    </span>
  );
}
export function FundSource({ fund }: { fund: ReferenceFund }) {
  const handle = normalizeXHandle(fund.xHandle);
  const url = handle && xProfileUrl(handle);
  if (!url) return null;
  return (
    <span className="fund-row-creator">
      <a className="fund-x-link" href={url} target="_blank" rel="noopener noreferrer">
        @{handle}
      </a>
    </span>
  );
}
export function FundIntroduction({ fund }: { fund: ReferenceFund }) {
  const [open, setOpen] = useState(false);
  const { profile, cover } = REFERENCE_METADATA[fund.slug];
  if (!profile) return <FundSource fund={fund} />;
  return (
    <>
      <button type="button" className="fund-introduction-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        Who is {profile.name}?
      </button>
      <ReferenceSheet open={open} onOpenChange={setOpen} title={profile.name}>
        <div className="fund-introduction">
          <div className="fund-introduction-identity">
            <img src={cover.thumbnailSrc} alt="" width={48} height={48} />
            <span>{profile.role}</span>
          </div>
          <p>{profile.bio}</p>
          <FundSource fund={fund} />
        </div>
      </ReferenceSheet>
    </>
  );
}
export function FundName({ fund, url }: { fund: ReferenceFund; url?: string }) {
  const root = useRef<HTMLSpanElement>(null),
    card = useRef<HTMLElement>(null),
    id = useId(),
    meta = REFERENCE_METADATA[fund.slug];
  useEffect(() => {
    if (!root.current || !card.current || !meta.profile) return;
    const binding = attachFundProfiles(root.current, card.current, () => ({
      profile: meta.profile!,
      image: meta.cover.thumbnailSrc,
    }));
    return () => binding.abort();
  }, [meta]);
  if (!meta.profile)
    return url ? (
      <Link className="fund-title-link" to={url}>
        {fund.name}
      </Link>
    ) : (
      <>{fund.name}</>
    );
  return (
    <span ref={root}>
      {url ? (
        <Link
          className="fund-title-link"
          to={url}
          data-fund-profile={fund.slug}
        >
          {fund.name}
        </Link>
      ) : (
        <button
          type="button"
          className="public-person-name"
          data-fund-profile={fund.slug}
          aria-haspopup="dialog"
          aria-controls={id}
        >
          {fund.name}
        </button>
      )}
      {createPortal(
        <aside
          ref={card}
          id={id}
          className="fund-profile-card"
          popover="manual"
          role="dialog"
          aria-label={`About ${meta.profile.name}`}
        />,
        document.getElementById("root") || document.body,
      )}
    </span>
  );
}
