import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { api } from './api';
import { errorMessage } from './format';
import type { SessionSnapshot } from './types';
import { Modal } from './ui';

function subscriptionError(failure: unknown) {
  const code = typeof failure === 'object' && failure !== null && 'code' in failure ? failure.code : undefined;
  return { code, message: errorMessage(failure) };
}

export function ChannelSubscribe({ channelId, videoId, title, session, onChanged, onSignIn }: {
  channelId: string | undefined;
  videoId?: string;
  title: string;
  session: SessionSnapshot;
  onChanged: () => void;
  onSignIn: () => void;
}) {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [error, setError] = useState<ReturnType<typeof subscriptionError> | null>(null);
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [retries, setRetries] = useState(0);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const active = useRef(false);
  const { generation, status } = session;
  const connected = status === 'connected';
  const needsSignIn = error?.code === 'sign_in_required' || status === 'expired';
  const checking = Boolean(connected && channelId && subscribed === null && !error);
  const disabledReason = !connected && status !== 'restoring' ? 'Sign in to YouTube to subscribe' : undefined;
  const statusChecked = useEffectEvent((value: boolean) => {
    setSubscribed(value);
    if (confirmationPending) {
      setConfirmationPending(false);
      onChanged();
    }
  });

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (!connected || !channelId) return;
    let current = true;
    void api.channelSubscription(channelId, generation, videoId).then(value => {
      if (current) statusChecked(value);
    }).catch(failure => {
      if (current) setError(subscriptionError(failure));
    });
    return () => { current = false; };
  }, [channelId, videoId, connected, generation, retries]);

  async function change(next: boolean) {
    if (!connected || !channelId || pending || needsSignIn || subscribed === null) return;
    setPending(true);
    setError(null);
    try {
      const value = await api.setChannelSubscription(channelId, generation, next, videoId);
      if (!active.current) return;
      setSubscribed(value);
      onChanged();
    } catch (failure) {
      if (!active.current) return;
      const issue = subscriptionError(failure);
      if (issue.code !== 'subscription_write_rejected') {
        setSubscribed(null);
        setConfirmationPending(issue.code !== 'subscription_status_unavailable' && issue.code !== 'sign_in_required');
      }
      setError(issue);
    } finally {
      if (active.current) {
        setConfirm(false);
        setPending(false);
      }
    }
  }

  return <div className="channel-subscription">
    <div className="channel-subscription-actions" title={disabledReason}>
      <button type="button" className={`button channel-subscribe${subscribed ? ' channel-subscribed' : ''}`}
        disabled={!connected || subscribed === null || pending || needsSignIn}
        title={disabledReason} aria-busy={checking || pending} aria-description={disabledReason}
        onClick={() => subscribed ? setConfirm(true) : void change(true)}>
        {checking || pending ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : subscribed ? <Check size={16} aria-hidden="true" /> : null}
        {subscribed ? 'Subscribed' : 'Subscribe'}
      </button>
      {needsSignIn && <button type="button" className="text-link" onClick={onSignIn}>Sign in</button>}
      {!needsSignIn && connected && error && subscribed === null && <button type="button" className="text-link"
        onClick={() => { setError(null); setRetries(value => value + 1); }}>{confirmationPending ? 'Check status' : 'Retry'}</button>}
    </div>
    {error && <p className="channel-subscription-error" role="alert">{error.message}</p>}
    {confirm && <Modal title="Unsubscribe?" onClose={() => { if (!pending) setConfirm(false); }}>
      <p className="modal-intro">Unsubscribe from {title}?</p>
      <div className="modal-footer">
        <button type="button" className="button secondary" disabled={pending} onClick={() => setConfirm(false)}>Cancel</button>
        <button type="button" className="button primary" disabled={pending} onClick={() => void change(false)}>Unsubscribe</button>
      </div>
    </Modal>}
  </div>;
}
