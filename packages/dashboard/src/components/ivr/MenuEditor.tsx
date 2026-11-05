'use client';

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  ACTION_LABELS,
  actionOfType,
  ActionType,
  describeAction,
  DTMF_KEYS,
  DtmfKey,
  finalActionOfType,
  formatDuration,
  IvrAssetMeta,
  IvrConfig,
  IvrOption,
  LIMITS,
  nextFreeKey,
} from '../../lib/ivr';
import { Badge, Button, Card, Field, Select, TextInput, Toggle } from '../ai/ui';
import { AudioPlayer } from './AudioPlayer';

/** A picker over the audio library. A value that is no longer in the library is shown as missing, never silently dropped. */
export function AssetSelect({
  assets,
  value,
  onChange,
  noneLabel = 'None',
  label,
}: {
  assets: IvrAssetMeta[];
  value: string | null;
  onChange: (id: string | null) => void;
  noneLabel?: string;
  label: string;
}) {
  const known = value === null || assets.some((a) => a.id === value);
  return (
    <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={label}>
      <option value="">{noneLabel}</option>
      {!known && <option value={value!}>Missing audio file (upload it again or choose another)</option>}
      {assets.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} · {formatDuration(a.durationMs)}
        </option>
      ))}
    </Select>
  );
}

type Slot = 'welcome' | 'menu' | 'invalid' | 'timeout';
const SLOTS: Array<{ slot: Slot; label: string; hint: string }> = [
  { slot: 'welcome', label: 'Welcome announcement', hint: 'Played first, when the person you called answers. Optional if the menu prompt says it all.' },
  { slot: 'menu', label: 'Menu prompt', hint: 'Tells the caller which keys to press ("Press 1 to talk to our assistant…"). Required when there are options.' },
  { slot: 'invalid', label: 'Invalid-input announcement', hint: 'Played after a key that is not one of the options. Optional: the menu simply plays again.' },
  { slot: 'timeout', label: 'No-input announcement', hint: 'Played when no key is pressed in time. Optional: the menu simply plays again.' },
];

export function AnnouncementsCard({ config, assets, onChange }: { config: IvrConfig; assets: IvrAssetMeta[]; onChange: (c: IvrConfig) => void }) {
  return (
    <Card title="Announcements" subtitle="Choose which uploaded recording plays at each step. Preview plays it here in the browser; no call is made.">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {SLOTS.map(({ slot, label, hint }) => (
          <div key={slot} className="space-y-2">
            <Field label={label} hint={hint}>
              <AssetSelect assets={assets} value={config[slot].assetId} onChange={(assetId) => onChange({ ...config, [slot]: { assetId } })} label={label} />
            </Field>
            {config[slot].assetId && assets.some((a) => a.id === config[slot].assetId) && <AudioPlayer assetId={config[slot].assetId!} />}
          </div>
        ))}
      </div>
    </Card>
  );
}

function OptionRow({
  index,
  option,
  assets,
  duplicate,
  onChange,
  onRemove,
}: {
  index: number;
  option: IvrOption;
  assets: IvrAssetMeta[];
  duplicate: boolean;
  onChange: (patch: Partial<IvrOption>) => void;
  onRemove: () => void;
}) {
  const action = option.action;
  return (
    <li className="border border-slate-800 rounded-lg p-3 space-y-3" aria-label={`Option ${index + 1}`}>
      <div className="grid grid-cols-1 md:grid-cols-[88px_1fr_1.2fr_auto] gap-3 items-end">
        <Field label="Key">
          <Select value={option.key} onChange={(e) => onChange({ key: e.target.value as DtmfKey })} aria-label={`Key for option ${index + 1}`}>
            {DTMF_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Label" hint="Only shown here, never spoken">
          <TextInput value={option.label} maxLength={LIMITS.labelMaxChars} onChange={(e) => onChange({ label: e.target.value })} aria-label={`Label for option ${index + 1}`} />
        </Field>
        <Field label="Action">
          <Select
            value={action.type}
            onChange={(e) => onChange({ action: actionOfType(e.target.value as ActionType, action) })}
            aria-label={`Action for option ${index + 1}`}
          >
            {(Object.keys(ACTION_LABELS) as ActionType[]).map((t) => (
              <option key={t} value={t}>
                {ACTION_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="danger" onClick={onRemove} aria-label={`Remove option ${index + 1}`}>
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
      {duplicate && <p className="text-[11px] text-rose-300">This key is also used by an earlier option. Each key can run only one action.</p>}
      {action.type === 'play-announcement' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Announcement to play">
            <AssetSelect assets={assets} value={action.assetId} noneLabel="Choose an announcement…" onChange={(assetId) => onChange({ action: { ...action, assetId } })} label={`Announcement for option ${index + 1}`} />
          </Field>
          <Field label="Afterwards">
            <Select value={action.then} onChange={(e) => onChange({ action: { ...action, then: e.target.value as 'return-to-menu' | 'hang-up' } })} aria-label={`After the announcement of option ${index + 1}`}>
              <option value="return-to-menu">Return to the menu</option>
              <option value="hang-up">Hang up</option>
            </Select>
          </Field>
          {action.assetId && assets.some((a) => a.id === action.assetId) && <AudioPlayer assetId={action.assetId} />}
        </div>
      )}
      {action.type === 'hang-up' && (
        <Field label="Goodbye before hanging up" hint="Optional. It plays to the end; keys cannot interrupt it.">
          <AssetSelect assets={assets} value={action.goodbyeAssetId} noneLabel="No goodbye: hang up at once" onChange={(goodbyeAssetId) => onChange({ action: { ...action, goodbyeAssetId } })} label={`Goodbye for option ${index + 1}`} />
        </Field>
      )}
      <p className="text-[11px] text-slate-500">
        Pressing <span className="font-mono text-slate-300">{option.key}</span> → {describeAction(action, assets)}
      </p>
    </li>
  );
}

export function OptionsCard({
  config,
  assets,
  onAdd,
  onRemove,
  onUpdate,
}: {
  config: IvrConfig;
  assets: IvrAssetMeta[];
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, patch: Partial<IvrOption>) => void;
}) {
  const firstUse = new Map<string, number>();
  const duplicates = config.options.map((o, i) => {
    if (!firstUse.has(o.key)) firstUse.set(o.key, i);
    return firstUse.get(o.key) !== i;
  });
  const canAdd = config.options.length < LIMITS.maxOptions && nextFreeKey(config) !== null;
  return (
    <Card
      title="Menu options"
      subtitle="What each key does. Keep the menu prompt in step with these: the prompt is what callers hear, the options are what the gateway does."
      actions={<Badge tone="neutral">{config.options.length} of {LIMITS.maxOptions}</Badge>}
    >
      {config.options.length === 0 && <p className="text-xs text-slate-500">No options. The caller will hear the announcements and the final action below runs without waiting for a key.</p>}
      <ul className="space-y-3" aria-label="Menu options">
        {config.options.map((option, i) => (
          <OptionRow key={i} index={i} option={option} assets={assets} duplicate={duplicates[i]} onChange={(patch) => onUpdate(i, patch)} onRemove={() => onRemove(i)} />
        ))}
      </ul>
      <Button onClick={onAdd} disabled={!canAdd}>
        <Plus className="w-3.5 h-3.5" /> Add option
      </Button>
    </Card>
  );
}

export function BehaviorCard({ config, assets, onChange }: { config: IvrConfig; assets: IvrAssetMeta[]; onChange: (c: IvrConfig) => void }) {
  const seconds = config.inputTimeoutMs / 1000;
  const final = config.finalAction;
  return (
    <Card title="Timing, retries and what happens at the end" subtitle="A wrong key or a silence is one mistake. More mistakes than the retry limit runs the final action.">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="Wait for a key (seconds)" hint={`${LIMITS.timeoutSeconds.min} to ${LIMITS.timeoutSeconds.max}. Counted from the end of the menu prompt.`}>
          <TextInput
            inputMode="decimal"
            value={Number.isFinite(seconds) ? String(seconds) : ''}
            onChange={(e) => onChange({ ...config, inputTimeoutMs: Math.round((Number(e.target.value) || 0) * 1000) })}
            aria-label="Seconds to wait for a key"
          />
        </Field>
        <Field label="Retries" hint="Mistakes allowed before the final action. 0 means the first mistake ends the menu.">
          <TextInput inputMode="numeric" value={String(config.maxRetries)} onChange={(e) => onChange({ ...config, maxRetries: Number(e.target.value) || 0 })} aria-label="Retries allowed" />
        </Field>
        <Field label="Final action" hint="When the retries run out, and when there are no options at all.">
          <Select value={final.type} onChange={(e) => onChange({ ...config, finalAction: finalActionOfType(e.target.value as 'connect-ai' | 'hang-up', final) })} aria-label="Final action">
            <option value="connect-ai">Connect to the AI assistant</option>
            <option value="hang-up">Hang up</option>
          </Select>
        </Field>
      </div>
      {final.type === 'hang-up' && (
        <Field label="Goodbye before the final hang-up" hint="Optional.">
          <AssetSelect assets={assets} value={final.goodbyeAssetId} noneLabel="No goodbye: hang up at once" onChange={(goodbyeAssetId) => onChange({ ...config, finalAction: { type: 'hang-up', goodbyeAssetId } })} label="Goodbye for the final action" />
        </Field>
      )}
      <Toggle
        checked={config.allowBargeIn}
        onChange={(allowBargeIn) => onChange({ ...config, allowBargeIn })}
        label="A key press stops the announcement that is playing"
        hint="Callers who know the menu can skip ahead. Turn this off to make every prompt play to the end."
      />
    </Card>
  );
}
