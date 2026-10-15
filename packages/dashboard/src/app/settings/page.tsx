'use client';

import React, { useEffect, useState } from 'react';
import {
  getGatewayClientConfig,
  saveGatewayClientConfig,
  clearGatewayClientConfig,
  DEFAULT_GATEWAY_URL,
} from '../../lib/config';
import { apiClient, GatewayApiClient, GatewayApiError } from '../../lib/api-client';
import { useGateway } from '../../lib/context/GatewayContext';
import {
  Sliders,
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  Radio,
  Server,
  Shield,
  HelpCircle,
  RefreshCw,
} from 'lucide-react';

export default function SettingsPage() {
  const { health, refreshHealth } = useGateway();

  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    latencyMs?: number;
  } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  useEffect(() => {
    const cfg = getGatewayClientConfig();
    setUrl(cfg.gatewayUrl);
    setApiKey(cfg.apiKey);
  }, []);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);

    const testClient = new GatewayApiClient({
      gatewayUrl: url,
      apiKey: apiKey,
    });

    const start = performance.now();
    try {
      const data = await testClient.getHealth();
      const latency = Math.round(performance.now() - start);

      setTestResult({
        success: true,
        message: `Connected successfully! Gateway v${data.gatewayVersion} (${data.driverType.toUpperCase()}), Latency: ${latency}ms`,
        latencyMs: latency,
      });
    } catch (err) {
      setTestResult({
        success: false,
        message: (err as Error).message,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveGatewayClientConfig(url, apiKey);
    setIsSaved(true);
    refreshHealth();
    setTimeout(() => setIsSaved(false), 3000);
  };

  const handleReset = () => {
    clearGatewayClientConfig();
    const cfg = getGatewayClientConfig();
    setUrl(cfg.gatewayUrl);
    setApiKey(cfg.apiKey);
    setIsSaved(true);
    refreshHealth();
    setTimeout(() => setIsSaved(false), 3000);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="border-b border-slate-800/80 pb-4">
        <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
          <Sliders className="w-5 h-5 text-cyan-400" />
          Gateway Connection & Security
        </h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Configure the REST API endpoint and authentication credentials for this dashboard session.
        </p>
      </div>

      {/* Connection Form */}
      <form onSubmit={handleSave} className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-5">
        <h2 className="text-sm font-semibold text-white uppercase tracking-wider font-mono flex items-center gap-2">
          <Server className="w-4 h-4 text-emerald-400" />
          Dashboard Connection Parameters
        </h2>

        <div className="space-y-4">
          {/* Gateway URL */}
          <div>
            <label className="block text-xs font-mono font-medium text-slate-300 mb-1.5">
              Gateway Service Base URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://127.0.0.1:4000"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"
              required
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Default is <code className="text-slate-400">http://127.0.0.1:4000</code> for local development. For remote Windows gateway access, enter its LAN IP (e.g. <code className="text-slate-400">http://192.168.1.50:4000</code>).
            </p>
          </div>

          {/* API Key */}
          <div>
            <label className="block text-xs font-mono font-medium text-slate-300 mb-1.5">
              Gateway API Key (Authentication)
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter gateway API key..."
                className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-3.5 pr-10 py-2 text-xs font-mono text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"
                required
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition"
                title={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              Matches <code className="text-slate-400">GATEWAY_API_KEY</code> on the gateway host. Stored locally in your browser session.
            </p>
          </div>
        </div>

        {/* Buttons */}
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            type="submit"
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white shadow-sm transition"
          >
            Save & Reconnect
          </button>

          <button
            type="button"
            onClick={handleTestConnection}
            disabled={isTesting || !url || !apiKey}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isTesting ? 'animate-spin' : ''}`} />
            <span>{isTesting ? 'Testing Ping...' : 'Test Connection'}</span>
          </button>

          <button
            type="button"
            onClick={handleReset}
            className="px-3 py-2 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition ml-auto"
          >
            Reset Defaults
          </button>
        </div>

        {/* Save confirmation */}
        {isSaved && (
          <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-800/80 text-emerald-400 text-xs font-mono flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>Connection parameters saved to browser session and reconnected!</span>
          </div>
        )}

        {/* Test Result Feedback */}
        {testResult && (
          <div
            className={`p-3 rounded-lg text-xs font-mono flex items-center gap-2 ${
              testResult.success
                ? 'bg-emerald-950/60 border border-emerald-800/80 text-emerald-400'
                : 'bg-rose-950/60 border border-rose-800/80 text-rose-300'
            }`}
          >
            {testResult.success ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{testResult.message}</span>
          </div>
        )}
      </form>

      {/* Host Settings Info Card */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-4">
        <h2 className="text-sm font-semibold text-white uppercase tracking-wider font-mono flex items-center gap-2">
          <Radio className="w-4 h-4 text-amber-400" />
          Gateway Host Configuration (Read-Only)
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
          <div className="bg-slate-950/60 rounded-lg p-3 border border-slate-800/80">
            <span className="text-slate-500 text-[10px] uppercase">Modem AT Port</span>
            <div className="text-slate-200 font-semibold mt-0.5">
              {health?.modem.atPort || 'COM20'} (115200 baud)
            </div>
          </div>

          <div className="bg-slate-950/60 rounded-lg p-3 border border-slate-800/80">
            <span className="text-slate-500 text-[10px] uppercase">USB Audio Port</span>
            <div className="text-slate-200 font-semibold mt-0.5">
              {health?.modem.audioPort || 'COM19'} (115200 baud)
            </div>
          </div>
        </div>

        <div className="p-3.5 rounded-lg bg-amber-950/40 border border-amber-800/60 text-amber-300 text-[11px] leading-relaxed">
          <span className="font-bold">Important Notice: </span>
          Host hardware settings (COM ports, serial baud rates, audio sample rates, SQLite path) are defined in the gateway service’s <code className="text-amber-200 font-mono">.env</code> file on the host machine. Changing them requires restarting the gateway process on the host.
        </div>
      </div>

      {/* Cross-Network LAN Setup Guide */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-3">
        <h2 className="text-sm font-semibold text-white uppercase tracking-wider font-mono flex items-center gap-2">
          <Shield className="w-4 h-4 text-purple-400" />
          Mac-to-Windows LAN Deployment Guide
        </h2>

        <p className="text-xs text-slate-400 leading-relaxed">
          To operate this dashboard on your Mac while the SIM7600EI gateway runs on the Windows PC:
        </p>

        <ol className="list-decimal list-inside text-xs text-slate-300 space-y-2 leading-relaxed">
          <li>
            On the Windows PC, set <code className="bg-slate-950 px-1.5 py-0.5 rounded text-cyan-400 font-mono">HOST=0.0.0.0</code> and a strong random <code className="bg-slate-950 px-1.5 py-0.5 rounded text-cyan-400 font-mono">GATEWAY_API_KEY</code> in its <code className="font-mono text-slate-200">.env</code>.
          </li>
          <li>
            In the Windows firewall, permit incoming TCP traffic on port 4000 strictly restricted to your Mac’s local subnet IP.
          </li>
          <li>
            In Windows <code className="font-mono text-slate-200">.env</code>, set <code className="bg-slate-950 px-1.5 py-0.5 rounded text-cyan-400 font-mono">CORS_ORIGIN=http://&lt;your-mac-ip&gt;:3000</code>.
          </li>
          <li>
            Enter the Windows PC LAN IP (e.g. <code className="bg-slate-950 px-1.5 py-0.5 rounded text-cyan-400 font-mono">http://192.168.1.50:4000</code>) and API key into the form above and click <strong>Save & Reconnect</strong>.
          </li>
        </ol>
      </div>
    </div>
  );
}
