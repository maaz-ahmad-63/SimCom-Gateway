'use client';

import React from 'react';
import { AlertCircle, CheckCircle2, HelpCircle, Loader2 } from 'lucide-react';
import { Badge, Card, Label } from '../ai/ui';
import {
  ComposeCheck,
  countSmsCharacters,
  formatSmsTime,
  messageBadge,
  Notice,
  smsDisplayText,
  SendView,
  SMS_MAX_SEPTETS,
  StoredSms,
} from '../../lib/sms';

const NOTICE_TONE: Record<Notice['tone'], string> = {
  good: 'bg-emerald-950/60 text-emerald-300 border-emerald-800/70',
  warn: 'bg-amber-950/60 text-amber-300 border-amber-800/70',
  bad: 'bg-rose-950/60 text-rose-300 border-rose-800/70',
  neutral: 'bg-slate-800/60 text-slate-300 border-slate-700/70',
};

export function NoticeList({ notices }: { notices: Notice[] }) {
  if (notices.length === 0) return null;
  return (
    <ul className="space-y-2" aria-label="Inbox notices">
      {notices.map((n) => (
        <li key={n.key} role={n.tone === 'bad' || n.tone === 'warn' ? 'alert' : undefined} className={`rounded-lg border px-3 py-2 text-xs ${NOTICE_TONE[n.tone]}`}>
          {n.text}
        </li>
      ))}
    </ul>
  );
}

export function SetupNotice({ text }: { text: string }) {
  return (
    <div role="alert" className="rounded-xl border border-amber-800/70 bg-amber-950/50 p-4 text-xs text-amber-200 space-y-2">
      <p className="font-semibold">SMS needs a one-time setup on the dashboard server</p>
      <p className="leading-relaxed">{text}</p>
    </div>
  );
}

const preview = (text: string) => (text.length > 90 ? `${text.slice(0, 90)}...` : text) || '(empty message)';

export function MessageList({
  messages,
  selectedId,
  onSelect,
  emptyText,
}: {
  messages: StoredSms[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  emptyText: string;
}) {
  if (messages.length === 0) return <p className="text-xs text-slate-500 py-6 text-center">{emptyText}</p>;
  return (
    <ul className="divide-y divide-slate-800/80 rounded-lg border border-slate-800/80 overflow-hidden" aria-label="Messages">
      {messages.map((m) => {
        const badge = messageBadge(m);
        const unread = m.direction === 'received' && m.read === false;
        return (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => onSelect(m.id)}
              aria-current={selectedId === m.id ? 'true' : undefined}
              className={`w-full text-left px-3 py-2.5 text-xs transition ${selectedId === m.id ? 'bg-slate-800' : 'hover:bg-slate-900/80'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`font-mono ${unread ? 'text-white font-semibold' : 'text-slate-300'}`}>{m.direction === 'received' ? 'From' : 'To'} {m.address ?? 'unknown'}</span>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">{formatSmsTime(m.time ?? m.firstSeenAt)}</div>
              <p className={`mt-1 break-words ${unread ? 'text-slate-100' : 'text-slate-400'}`}>{preview(smsDisplayText(m).text)}</p>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function MessageDetail({
  message,
  modemCopy,
  busy,
  error,
  onReadFromModem,
}: {
  message: StoredSms | null;
  modemCopy: { text: string; status: string } | null;
  busy: boolean;
  error: string | null;
  onReadFromModem: (index: number) => void;
}) {
  if (!message) return <p className="text-xs text-slate-500 py-6 text-center">Select a message to read it.</p>;
  const badge = messageBadge(message);
  const shown = smsDisplayText(message);
  const canRead = message.direction === 'received' && message.index !== null && message.onModem;
  return (
    <article className="space-y-3 text-xs" aria-label="Message details">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-sm text-white">{message.direction === 'received' ? 'From' : 'To'} {message.address ?? 'unknown'}</h3>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-300">
        <dt className="text-slate-500">{message.direction === 'received' ? 'Received' : 'Sent'}</dt>
        <dd>{formatSmsTime(message.time ?? message.firstSeenAt)}</dd>
        {message.modemStatus && (
          <>
            <dt className="text-slate-500">On the modem</dt>
            <dd>{message.modemStatus}{message.storage ? ` (${message.storage} #${message.index})` : ''}</dd>
          </>
        )}
        {message.messageReference !== null && (
          <>
            <dt className="text-slate-500">Reference</dt>
            <dd className="font-mono">{message.messageReference}</dd>
          </>
        )}
      </dl>
      {message.direction === 'received' && !message.onModem && (
        <p className="text-amber-300">This message is no longer in the modem's storage (it was deleted there). The gateway keeps its copy.</p>
      )}
      {message.sendStatus === 'unknown' && (
        <p role="alert" className="rounded border border-amber-800/70 bg-amber-950/50 p-2 text-amber-200">
          It is not known whether this message was sent{message.errorMessage ? `: ${message.errorMessage}` : ''}. It was not retried. Check with the recipient before sending it again.
        </p>
      )}
      {message.sendStatus === 'failed' && (
        <p role="alert" className="rounded border border-rose-800/70 bg-rose-950/50 p-2 text-rose-200">
          The modem did not send this message{message.errorMessage ? `: ${message.errorMessage}` : ''}.
        </p>
      )}
      <div>
        <Label>Message</Label>
        <p className="whitespace-pre-wrap break-words rounded-lg border border-slate-800/80 bg-slate-950/60 p-3 text-sm text-slate-100">{shown.text || '(empty message)'}</p>
        {shown.encoding === 'ucs2' && (
          <details className="mt-1 text-[11px] text-slate-500">
            <summary className="cursor-pointer">Received as UCS-2 (16-bit) text; show what the modem reported</summary>
            <code className="block break-all font-mono text-slate-400">{shown.rawText}</code>
          </details>
        )}
      </div>
      {canRead && (
        <div className="space-y-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onReadFromModem(message.index as number)}
            className="rounded bg-slate-800 px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {busy ? 'Reading...' : 'Read this message from the modem'}
          </button>
          <p className="text-[11px] text-slate-500">Asks the modem for its copy without changing its read/unread status. Not available during a call.</p>
          {modemCopy && (
            <p className="rounded border border-slate-800 bg-slate-950/60 p-2 text-slate-300">
              Modem copy ({modemCopy.status}): <span className="whitespace-pre-wrap break-words text-slate-100">{smsDisplayText({ direction: message.direction, text: modemCopy.text }).text || '(empty message)'}</span>
            </p>
          )}
          {error && <p role="alert" className="text-rose-300">{error}</p>}
        </div>
      )}
    </article>
  );
}

export function SendOutcome({ view }: { view: SendView }) {
  const tone = view.state === 'sent' ? 'good' : view.state === 'uncertain' ? 'warn' : 'bad';
  const Icon = view.state === 'sent' ? CheckCircle2 : view.state === 'uncertain' ? HelpCircle : AlertCircle;
  return (
    <div role={view.state === 'sent' ? 'status' : 'alert'} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${NOTICE_TONE[tone]}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-semibold">{view.title}</p>
        <p className="mt-0.5 leading-relaxed">{view.detail}</p>
      </div>
    </div>
  );
}

export function ComposeForm({
  to,
  message,
  onTo,
  onMessage,
  onSend,
  sending,
  check,
  touched,
  view,
  needsAck,
  acked,
  onAck,
  blockedReason,
}: {
  to: string;
  message: string;
  onTo: (value: string) => void;
  onMessage: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  check: ComposeCheck;
  touched: boolean;
  view: SendView | null;
  /** The last send's outcome is unknown: sending again needs an explicit confirmation. */
  needsAck: boolean;
  acked: boolean;
  onAck: (value: boolean) => void;
  blockedReason: string | null;
}) {
  const used = countSmsCharacters(message);
  const disabled = sending || !check.ok || blockedReason !== null || (needsAck && !acked);
  return (
    <Card title="New message" subtitle="Sends one SMS through the modem. Nothing is sent until you press Send, and a send is never repeated automatically.">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) onSend();
        }}
      >
        <div>
          <label htmlFor="sms-to" className="block text-[10px] text-slate-500 uppercase font-mono mb-1">Recipient</label>
          <input
            id="sms-to"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={to}
            onChange={(event) => onTo(event.target.value)}
            placeholder="+919876543210"
            aria-invalid={touched && check.errors.to ? 'true' : undefined}
            aria-describedby="sms-to-error"
            className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 font-mono"
          />
          <p id="sms-to-error" className="mt-1 min-h-[1rem] text-[11px] text-rose-300">{touched ? check.errors.to : ''}</p>
        </div>
        <div>
          <label htmlFor="sms-message" className="block text-[10px] text-slate-500 uppercase font-mono mb-1">Message</label>
          <textarea
            id="sms-message"
            rows={4}
            value={message}
            onChange={(event) => onMessage(event.target.value)}
            aria-invalid={touched && check.errors.message ? 'true' : undefined}
            aria-describedby="sms-message-error"
            className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          />
          <div className="mt-1 flex items-start justify-between gap-3">
            <p id="sms-message-error" className="min-h-[1rem] text-[11px] text-rose-300">{touched ? check.errors.message : ''}</p>
            <span className={`shrink-0 font-mono text-[11px] ${used > SMS_MAX_SEPTETS ? 'text-rose-300' : 'text-slate-500'}`}>{used}/{SMS_MAX_SEPTETS}</span>
          </div>
        </div>
        {needsAck && (
          <label className="flex items-start gap-2 rounded-lg border border-amber-800/70 bg-amber-950/50 p-2 text-xs text-amber-200">
            <input type="checkbox" checked={acked} onChange={(event) => onAck(event.target.checked)} className="mt-0.5" />
            <span>The last message may or may not have been sent. I have checked with the recipient and want to send again.</span>
          </label>
        )}
        {blockedReason && <p role="alert" className="text-xs text-amber-300">{blockedReason}</p>}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={disabled} className="inline-flex items-center gap-2 rounded bg-cyan-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">
            {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {sending ? 'Sending... this can take up to a minute' : 'Send'}
          </button>
        </div>
        {view && <SendOutcome view={view} />}
      </form>
    </Card>
  );
}
