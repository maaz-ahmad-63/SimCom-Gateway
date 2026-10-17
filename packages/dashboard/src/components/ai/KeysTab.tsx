'use client';

import React, { useState } from 'react';
import type { AiCredentialStatus } from '@sim-gateway/shared';
import { apiClient } from '../../lib/api-client';
import { credentialBadges, validateKeyInput } from '../../lib/ai-secrets';
import { useAi } from '../../lib/context/AiContext';
import { formatDate } from '../../lib/utils';
import { ActionNote, Badge, Button, Card, TextInput, useAction } from './ui';

function KeyRow({ credential, canStore }: { credential: AiCredentialStatus; canStore: boolean }) {
  const { refresh } = useAi();
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [action, run, reset] = useAction();
  const badges = credentialBadges(credential);
  const inputError = value ? validateKeyInput(value) : null;

  const save = async () => {
    const ok = await run(() => apiClient.saveAiCredential(credential.name, value.trim()), 'Key saved. It is stored encrypted and will not be shown again.');
    if (ok) {
      setValue(''); // the key never stays in the page after it is sent
      setEditing(false);
      await refresh();
    }
  };

  return (
    <li className="bg-slate-950/50 border border-slate-800 rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm text-slate-100">{credential.provider}</p>
          <p className="text-[11px] font-mono text-slate-500">{credential.name}</p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {credential.requiredBySelection && <Badge tone="neutral">used by current selection</Badge>}
          <Badge tone={badges.presence.tone}>{badges.presence.label}</Badge>
          <Badge tone={badges.check.tone}>{badges.check.label}</Badge>
        </div>
      </div>
      {credential.lastCheckDetail && (
        <p className="text-[11px] text-slate-400">
          {credential.lastCheckDetail}
          {credential.lastCheckedAt && ` · ${formatDate(credential.lastCheckedAt)}`}
        </p>
      )}

      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!inputError && value) void save();
          }}
        >
          <TextInput
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`Paste the ${credential.provider} API key`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`${credential.provider} API key`}
          />
          {inputError && <p className="text-[11px] text-amber-300">{inputError}</p>}
          <div className="flex gap-2">
            <Button variant="primary" type="submit" disabled={!value || !!inputError} busy={action.status === 'running'}>
              Save key
            </Button>
            <Button
              onClick={() => {
                setValue('');
                setEditing(false);
                reset();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditing(true)} disabled={!canStore} title={canStore ? undefined : 'Enable key storage first'}>
            {credential.source === 'stored' ? 'Replace key' : credential.source === 'env' ? 'Override .env key' : 'Add key'}
          </Button>
          <Button
            disabled={credential.source === 'missing'}
            busy={action.status === 'running'}
            onClick={async () => {
              await run(() => apiClient.validateAiCredential(credential.name), 'Check finished');
              await refresh();
            }}
          >
            Check with provider
          </Button>
          {credential.source === 'stored' &&
            (confirmRemove ? (
              <>
                <Button
                  variant="danger"
                  onClick={async () => {
                    setConfirmRemove(false);
                    await run(() => apiClient.removeAiCredential(credential.name), 'Stored key removed');
                    await refresh();
                  }}
                >
                  Remove permanently
                </Button>
                <Button onClick={() => setConfirmRemove(false)}>Keep</Button>
              </>
            ) : (
              <Button onClick={() => setConfirmRemove(true)}>Remove</Button>
            ))}
        </div>
      )}
      {credential.source === 'env' && !editing && <p className="text-[11px] text-slate-500">This key comes from the gateway’s .env file. Saving one here takes precedence over it; removing the saved one falls back to .env.</p>}
      <ActionNote state={action} />
    </li>
  );
}

export function KeysTab() {
  const { state, error } = useAi();
  if (!state) return <p className="text-xs text-slate-500">{error ?? 'Loading…'}</p>;
  const canStore = state.settings.secretStorageAvailable;
  return (
    <div className="space-y-6">
      <Card
        title="Provider API keys"
        subtitle="Keys are sent to the gateway once, stored encrypted on the gateway machine, and never sent back to this page. The gateway’s own API key (Settings page) is separate."
      >
        {!canStore && (
          <div className="text-xs rounded-md border border-amber-800/70 bg-amber-950/50 text-amber-200 px-3 py-2 space-y-1">
            <p>
              <strong>Key storage is off.</strong> To store keys from this page, add a line to the gateway’s <span className="font-mono">.env</span> and restart the gateway:
            </p>
            <p className="font-mono">AI_SECRETS_MASTER_KEY=&lt;16 or more random characters&gt;</p>
            <p>Keys already in .env keep working and show as “Set in .env”.</p>
          </div>
        )}
        <ul className="space-y-3">
          {state.credentials.map((c) => (
            <KeyRow key={c.name} credential={c} canStore={canStore} />
          ))}
        </ul>
        <ul className="text-[11px] text-slate-500 list-disc pl-4 space-y-0.5">
          <li>“Missing” means no key exists. “Provider rejected it” means a key exists but the provider said it is not valid. “Could not reach provider” means the check failed on the network or at the provider, so the key could not be judged.</li>
          <li>“Check with provider” makes one read-only request to the provider’s own account/model listing endpoint; it does not run speech, text or voice generation.</li>
          <li>The gateway never switches provider on its own: if a key is missing or rejected, that stage fails and says so.</li>
        </ul>
      </Card>
    </div>
  );
}
