'use client';

import React from 'react';
import { KeysTab } from '../../../components/ai/KeysTab';
import { EnvImport } from '../../../components/settings/EnvImport';
import { SettingsNav } from '../../../components/settings/SettingsNav';
import { AiProvider } from '../../../lib/context/AiContext';

export default function ApiKeysPage() {
  return (
    <div className="space-y-6">
      <SettingsNav />
      <AiProvider>
        <EnvImport />
        <KeysTab />
      </AiProvider>
    </div>
  );
}
