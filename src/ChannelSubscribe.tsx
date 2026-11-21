import { useEffect, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { api } from './api';
import { errorMessage } from './format';
import type { SessionSnapshot } from './types';
import { Modal } from './ui';

export function ChannelSubscribe({ channelId, title, session, onChanged }: {
  channelId: string | undefined;
  title: string;
  session: SessionSnapshot;
  onChanged: () => void;
}) {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [retries, setRetries] = useState(0);
  const { generation, status } = session;
  const connected = status === 'connected';
  const checking = Boolean(connected && channelId && subscribed === null && !error);
  const disabledReason = !connected && status !== 'restoring' ? 'Sign in to YouTube to subscribe' : undefined;

  useEffect(() => {
    if (!connected || !channelId) return;
    let current = true;
    void api.channelSubscription(channelId, generation).then(value => {
      if (current) setSubscribed(value);
    }).catch(failure => {
      if (current) setError(errorMessage(failure));
    });
    return () => { current = false; };
  }, [channelId, connected, generation, retries]);

  async function change(next: boolean) {
    if (!connected || !channelId || pending || subscribed === null) return;
    setPending(true);
    setError('');
    try {
      setSubscribed(await api.setChannelSubscription(channelId, generation, next));
      onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setConfirm(false);
      setPending(false);
    }
  }

  return <div className="channel-subscription">
    <div className="channel-subscription-actions" title={disabledReason}>
      <button type="button" className={`button channel-subscribe${subscribed ? ' channel-subscribed' : ''}`}
        disabled={!connected || subscribed === null || pending}
        title={disabledReason} aria-busy={checking || pending} aria-description={disabledReason}
        onClick={() => subscribed ? setConfirm(true) : void change(true)}>
        {checking || pending ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : subscribed ? <Check size={16} aria-hidden="true" /> : null}
        {subscribed ? 'Subscribed' : 'Subscribe'}
      </button>
      {error && subscribed === null && <button type="button" className="text-link" onClick={() => { setError(''); setRetries(value => value + 1); }}>Retry</button>}
    </div>
    {error && <p className="channel-subscription-error" role="alert">{error}</p>}
    {confirm && <Modal title="Unsubscribe?" onClose={() => { if (!pending) setConfirm(false); }}>
      <p className="modal-intro">Unsubscribe from {title}?</p>
      <div className="modal-footer">
        <button type="button" className="button secondary" disabled={pending} onClick={() => setConfirm(false)}>Cancel</button>
        <button type="button" className="button primary" disabled={pending} onClick={() => void change(false)}>Unsubscribe</button>
      </div>
    </Modal>}
  </div>;
}
