'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Badge } from '../../components/ai/ui';
import { ComposeForm, MessageDetail, MessageList, NoticeList, SetupNotice } from '../../components/sms/SmsPanels';
import { useGateway } from '../../lib/context/GatewayContext';
import {
  checkCompose,
  describeSendError,
  describeSendResult,
  inboxNotices,
  InboxState,
  listState,
  pollDelayMs,
  unseenSmsAlerts,
  setupProblem,
  smsApi,
  SmsApiError,
  SendView,
  StatusResponse,
  StoredSms,
} from '../../lib/sms';

type Tab = 'inbox' | 'sent';

/** The page reads the gateway's stored copy (database only) every 30 s while visible, every 2 min while the gateway keeps failing. */
const ERRORS_BEFORE_SHOWN = 3;

export default function SmsPage() {
  const { activeCall, recentAlerts } = useGateway();
  const callActive = Boolean(activeCall && activeCall.state !== 'IDLE');

  const [tab, setTab] = useState<Tab>('inbox');
  const [messages, setMessages] = useState<StoredSms[]>([]);
  const [unread, setUnread] = useState(0);
  const [inbox, setInbox] = useState<InboxState | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<SmsApiError | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendView, setSendView] = useState<SendView | null>(null);
  const [acked, setAcked] = useState(false);

  const [modemCopy, setModemCopy] = useState<{ id: number; text: string; status: string } | null>(null);
  const [modemBusy, setModemBusy] = useState(false);
  const [modemError, setModemError] = useState<string | null>(null);

  const [smsStatus, setSmsStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  const pollErrors = useRef(0);
  const tabRef = useRef<Tab>(tab);
  tabRef.current = tab;

  /** Read the gateway's stored copy (database only: no modem command, never changes a read/unread status). */
  const load = useCallback(async (manual = false) => {
    try {
      const response = await smsApi.inbox(tabRef.current === 'inbox' ? 'received' : 'sent');
      setMessages(response.messages);
      setInbox(response.inbox);
      if (tabRef.current === 'inbox') setUnread(response.unread);
      setError(null);
      pollErrors.current = 0;
    } catch (e) {
      pollErrors.current += 1;
      // A single missed background read is not shown; a manual one, or repeated failures, are.
      if (manual || pollErrors.current >= ERRORS_BEFORE_SHOWN) setError(e as SmsApiError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setSelectedId(null);
    void load(true);
  }, [tab, load]);

  // Bounded fallback for the realtime nudge (which needs this browser's own live connection): one database read per period,
  // only while the page is visible, slowing down while the gateway keeps failing. It sends nothing to the modem.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const next = () => {
      timer = setTimeout(async () => {
        if (stopped) return;
        if (document.visibilityState === 'visible') await load();
        if (!stopped) next();
      }, pollDelayMs(pollErrors.current));
    };
    next();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  // The gateway announces new messages as an info alert ("SMS: 2 new messages received") over the existing realtime link.
  const seenAlerts = useRef<Set<string> | null>(null);
  useEffect(() => {
    const keys = unseenSmsAlerts(recentAlerts, seenAlerts.current ?? new Set());
    if (seenAlerts.current === null) {
      // Alerts that were already there when the page opened are history; the first load covers them.
      seenAlerts.current = new Set(keys);
      return;
    }
    if (keys.length === 0) return;
    for (const key of keys) seenAlerts.current.add(key);
    void load();
  }, [recentAlerts, load]);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const result = await smsApi.sync();
      setRefreshNote(result.added > 0 ? `${result.added} new message${result.added === 1 ? '' : 's'} read from the modem` : 'No new messages on the modem');
      pollErrors.current = 0;
      await load(true);
    } catch (e) {
      setError(e as SmsApiError);
    } finally {
      setRefreshing(false);
    }
  };

  const check = useMemo(() => checkCompose(to, text), [to, text]);
  const needsAck = sendView?.state === 'uncertain';
  const blockedReason = callActive ? 'A call is in progress. Sending is unavailable until it ends.' : null;

  const send = async () => {
    setTouched(true);
    if (!check.ok || sending) return;
    setSending(true);
    setSendView(null);
    try {
      const result = await smsApi.send(check.to, text);
      setSendView(describeSendResult(result));
      setText('');
      setTouched(false);
      setAcked(false);
    } catch (e) {
      // Never retried here. An uncertain result keeps the text and asks for an explicit confirmation before another send.
      setSendView(describeSendError(e));
      setAcked(false);
    } finally {
      setSending(false);
      void load();
    }
  };

  const readFromModem = async (index: number) => {
    setModemBusy(true);
    setModemError(null);
    try {
      const response = await smsApi.modemMessage(index);
      setModemCopy({ id: selectedId ?? -1, text: response.message.text, status: response.message.status });
    } catch (e) {
      setModemError((e as Error).message);
    } finally {
      setModemBusy(false);
    }
  };

  const checkSettings = async () => {
    setStatusBusy(true);
    setStatusError(null);
    try {
      setSmsStatus(await smsApi.status());
    } catch (e) {
      setStatusError((e as Error).message);
    } finally {
      setStatusBusy(false);
    }
  };

  const selected = messages.find((m) => m.id === selectedId) ?? null;
  const setup = setupProblem(error);
  const notices = inboxNotices(inbox, callActive);
  // Empty means the gateway answered with no messages; offline, a rejected key or missing setup are said as such.
  const listView = listState({ loading, error, count: messages.length, inbox, folder: tab });

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800/80 pb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-white">SMS</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Messages the modem receives are copied to the gateway and kept there. Opening or refreshing this page never marks a message as read, and nothing is deleted.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {unread > 0 && <Badge tone="warn">{unread} unread</Badge>}
          <button type="button" disabled={refreshing || callActive} onClick={() => void refresh()} className="rounded bg-slate-800 px-3 py-1.5 text-xs text-white disabled:opacity-50">
            {refreshing ? 'Reading the modem...' : 'Refresh from modem'}
          </button>
        </div>
      </div>

      {setup && <SetupNotice text={setup} />}
      {error && !setup && (
        <div role="alert" className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-rose-300 text-xs">
          {error.message}
        </div>
      )}
      {refreshNote && !error && <p role="status" className="text-xs text-slate-400">{refreshNote}</p>}
      <NoticeList notices={notices} />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="flex gap-2" role="tablist" aria-label="Message folders">
            {(['inbox', 'sent'] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
                className={`rounded px-3 py-1.5 text-xs ${tab === name ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'}`}
              >
                {name === 'inbox' ? 'Inbox' : 'Sent'}
              </button>
            ))}
          </div>
          {listView.kind !== 'messages' && listView.kind !== 'empty' ? (
            <p role={listView.kind === 'loading' ? 'status' : 'alert'} className={`text-xs py-6 text-center ${listView.kind === 'loading' ? 'text-slate-500' : 'text-amber-300'}`}>
              {listView.text}
            </p>
          ) : (
            <MessageList
              messages={messages}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                setModemCopy(null);
                setModemError(null);
              }}
              emptyText={listView.text}
            />
          )}
          <Card title="Message">
            <MessageDetail
              message={selected}
              modemCopy={modemCopy && modemCopy.id === selectedId ? modemCopy : null}
              busy={modemBusy}
              error={modemError}
              onReadFromModem={(index) => void readFromModem(index)}
            />
          </Card>
        </div>

        <div className="space-y-4">
          <ComposeForm
            to={to}
            message={text}
            onTo={setTo}
            onMessage={setText}
            onSend={() => void send()}
            sending={sending}
            check={check}
            touched={touched}
            view={sendView}
            needsAck={needsAck}
            acked={acked}
            onAck={setAcked}
            blockedReason={blockedReason}
          />
          <Card title="Modem SMS settings" subtitle="A read-only check of what the modem is set to (service centre, text-mode parameters, character set). It changes nothing.">
            <button type="button" disabled={statusBusy || callActive} onClick={() => void checkSettings()} className="rounded bg-slate-800 px-3 py-1.5 text-xs text-white disabled:opacity-50">
              {statusBusy ? 'Checking...' : 'Check settings'}
            </button>
            {statusError && <p role="alert" className="text-xs text-rose-300">{statusError}</p>}
            {smsStatus && (
              <div className="space-y-2 text-xs">
                <p className={smsStatus.assessment.canSend ? 'text-emerald-300' : 'text-amber-300'}>
                  {smsStatus.assessment.canSend ? 'The modem looks ready to send.' : 'The modem is not ready to send:'}
                </p>
                <ul className="list-disc pl-5 text-slate-300 space-y-1">
                  {smsStatus.assessment.problems.map((p) => <li key={p} className="text-amber-200">{p}</li>)}
                  {smsStatus.assessment.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
                <p className="text-[11px] text-slate-500">To change a setting, use the gateway API on the PC (the dashboard cannot change modem settings).</p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
