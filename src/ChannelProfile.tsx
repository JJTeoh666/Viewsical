import { useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { BadgeCheck, RefreshCw } from 'lucide-react';
import { ChannelSubscribe } from './ChannelSubscribe';
import type { BrowseKind, ChannelSummary, ChannelTab, SessionSnapshot } from './types';
import { IconButton } from './ui';
import './channel-profile.css';

const sections = [
  { id: 'home', label: 'Home' },
  { id: 'videos', label: 'Videos' },
  { id: 'live', label: 'Live' },
  { id: 'playlists', label: 'Playlists' },
] as const;

export const channelBrowseKind = {
  home: 'channel-home', videos: 'channel', live: 'channel-live', playlists: 'channel-playlists',
} as const satisfies Record<ChannelTab, BrowseKind>;

const compactCount = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function ChannelProfile({ channel, query, fallbackTitle, fallbackAvatar, session, onSubscriptionChange, tab, onTab, onRefresh, loading, children }: {
  channel: ChannelSummary | undefined;
  query: string | undefined;
  fallbackTitle: string | undefined;
  fallbackAvatar: string | null | undefined;
  session: SessionSnapshot;
  onSubscriptionChange: () => void;
  tab: ChannelTab;
  onTab: (tab: ChannelTab) => void;
  onRefresh: () => void;
  loading: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const tabs = useRef<HTMLDivElement>(null);
  const id = useId();
  const title = channel?.title || fallbackTitle || 'YouTube channel';
  const channelId = channel?.id || (query && /^UC[\w-]{22}$/.test(query) ? query : undefined);
  const avatar = channel?.avatar || fallbackAvatar;
  const description = channel?.description?.trim();
  const compact = description?.replace(/\s+/g, ' ');
  const excerpt = Array.from(compact ?? '').slice(0, 150).join('').trimEnd();
  const canExpand = Boolean(description && (description !== compact || excerpt !== compact));

  function tabKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    const end = sections.length - 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? end : direction ? (index + direction + sections.length) % sections.length : index;
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    onTab(sections[next].id);
    tabs.current?.querySelectorAll('button')[next]?.focus({ preventScroll: true });
  }

  return <section className="channel-profile" aria-label={title}>
    <header className="channel-profile-header">
      {channel?.banner && <div className="channel-profile-banner"><img key={channel.banner} src={channel.banner} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} /></div>}
      <div className="channel-profile-identity">
        <span className="channel-profile-avatar" aria-hidden="true">
          {Array.from(title)[0].toUpperCase()}
          {avatar && <img key={avatar} src={avatar} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} />}
        </span>
        <div className="channel-profile-copy">
          <h1 tabIndex={-1}>{title}{channel?.isVerified && <BadgeCheck className="channel-profile-verified" size={23} aria-label="Verified channel" role="img" />}</h1>
          <div className="channel-profile-stats">
            {channel?.handle && <strong>{channel.handle}</strong>}
            {channel?.subscriberCount != null && <span>{compactCount.format(channel.subscriberCount)} {channel.subscriberCount === 1 ? 'subscriber' : 'subscribers'}</span>}
            {channel?.videoCount != null && <span>{compactCount.format(channel.videoCount)} {channel.videoCount === 1 ? 'video' : 'videos'}</span>}
          </div>
          {description && <div className="channel-profile-about">
            <p id={`${id}-about`}>{expanded ? description : excerpt === compact ? excerpt : `${excerpt}…`}</p>
            {canExpand && <button type="button" className="text-link" aria-controls={`${id}-about`} aria-expanded={expanded}
              onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Read more'}</button>}
          </div>}
          <ChannelSubscribe key={`${channelId}:${session.generation}:${session.status}`} channelId={channelId}
            title={title} session={session} onChanged={onSubscriptionChange} />
        </div>
      </div>
    </header>
    <div className="channel-profile-navigation">
      <div className="channel-profile-tabs" role="tablist" aria-label="Channel sections" ref={tabs}>
        {sections.map(({ id: section, label }, index) => <button key={section} id={`${id}-${section}`} type="button" role="tab"
          aria-selected={tab === section} aria-controls={`${id}-panel`} tabIndex={tab === section ? 0 : -1}
          onKeyDown={event => tabKeys(event, index)} onClick={() => onTab(section)}>{label}</button>)}
      </div>
      <IconButton label="Refresh channel" disabled={loading} onClick={onRefresh}><RefreshCw size={18} className={loading ? 'spin' : ''} /></IconButton>
    </div>
    <div id={`${id}-panel`} className="channel-profile-panel" role="tabpanel" aria-labelledby={`${id}-${tab}`} tabIndex={0}>
      {children}
    </div>
  </section>;
}
