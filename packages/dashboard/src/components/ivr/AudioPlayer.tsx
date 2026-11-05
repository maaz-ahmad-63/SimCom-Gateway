'use client';

import React, { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { apiClient } from '../../lib/api-client';
import { Button } from '../ai/ui';

/** Preview one announcement. The file is fetched with the API key only when asked for, and played from the browser; nothing is sent to a call. */
export function AudioPlayer({ assetId }: { assetId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    setError(null);
  }, [assetId]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setUrl(URL.createObjectURL(await apiClient.downloadIvrAsset(assetId)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (url) return <audio controls autoPlay src={url} className="h-8 max-w-full" aria-label="Announcement preview" />;
  return (
    <span className="inline-flex items-center gap-2">
      <Button onClick={load} busy={busy} aria-label="Preview this announcement">
        <Play className="w-3 h-3" /> Preview
      </Button>
      {error && <span className="text-[11px] text-rose-300">{error}</span>}
    </span>
  );
}
