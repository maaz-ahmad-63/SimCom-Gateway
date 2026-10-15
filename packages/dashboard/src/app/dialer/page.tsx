'use client';

import React, { useState } from 'react';
import { useGateway } from '../../lib/context/GatewayContext';
import { DialPad } from '../../components/dialer/DialPad';
import { CallControls } from '../../components/dialer/CallControls';
import { VuMeter } from '../../components/dashboard/VuMeter';
import { validatePhoneNumber } from '../../lib/utils';
import { Delete, Hash, Phone, ShieldCheck, AlertCircle } from 'lucide-react';

export default function DialerPage() {
  const { activeCall, dial } = useGateway();
  const [phoneNumber, setPhoneNumber] = useState('+91');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isCallInProgress = Boolean(activeCall && activeCall.state !== 'IDLE');
  const isCallActive = activeCall?.state === 'ACTIVE';

  const handleKeyPress = (char: string) => {
    if (isCallInProgress) return;
    setPhoneNumber((prev) => prev + char);
  };

  const handleBackspace = () => {
    if (isCallInProgress) return;
    setPhoneNumber((prev) => prev.slice(0, -1));
  };

  const isValidNumber = validatePhoneNumber(phoneNumber);

  const handleDial = async () => {
    if (!isValidNumber || isCallInProgress) return;

    setSubmitError(null);
    setIsSubmitting(true);

    try {
      await dial({
        phoneNumber: phoneNumber.trim(),
        timeoutSeconds: 45,
      });
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div className="text-center space-y-1">
        <h1 className="text-xl font-bold tracking-tight text-white flex items-center justify-center gap-2">
          <Phone className="w-5 h-5 text-emerald-400" />
          Cellular Dialer
        </h1>
        <p className="text-xs text-slate-400">
          Make outbound calls or transmit DTMF tones over the cellular line.
        </p>
      </div>

      {/* Main Dialer Box */}
      <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
        {/* State / Caller Banner */}
        {isCallInProgress && (
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between font-mono text-xs">
            <div>
              <div className="text-[10px] text-slate-500 uppercase">Current Call</div>
              <div className="font-bold text-white text-sm">
                {activeCall?.remoteNumber}
              </div>
            </div>

            <span className="px-2 py-0.5 rounded font-semibold text-emerald-400 bg-emerald-950/80 border border-emerald-800/80 animate-pulse">
              {activeCall?.state}
            </span>
          </div>
        )}

        {/* In-Call DTMF Mode Notice */}
        {isCallActive && (
          <div className="p-2.5 rounded-lg bg-cyan-950/40 border border-cyan-800/60 text-cyan-300 text-xs font-mono flex items-center gap-2">
            <Hash className="w-4 h-4 shrink-0 text-cyan-400" />
            <span>In-Call Keypad Active: Tap digits below to send DTMF audio tones.</span>
          </div>
        )}

        {/* Phone Number Display / Input */}
        {!isCallInProgress && (
          <div className="space-y-1.5">
            <div className="relative">
              <input
                type="text"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="+91..."
                className="w-full h-14 bg-slate-950 border border-slate-800 rounded-xl px-4 text-center text-2xl font-bold font-mono text-white placeholder-slate-700 tracking-wider focus:outline-none focus:border-cyan-500"
              />

              {phoneNumber.length > 0 && (
                <button
                  type="button"
                  onClick={handleBackspace}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
                  title="Backspace"
                >
                  <Delete className="w-5 h-5" />
                </button>
              )}
            </div>

            {/* Validation Feedback */}
            <div className="flex items-center justify-between px-1 text-[11px] font-mono">
              <span className="text-slate-500">Format: E.164 (7-15 digits)</span>
              {phoneNumber.length > 2 && (
                <span
                  className={
                    isValidNumber ? 'text-emerald-400 font-semibold' : 'text-amber-400'
                  }
                >
                  {isValidNumber ? 'Valid Phone Number' : 'Incomplete / Invalid Number'}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Error Message */}
        {submitError && (
          <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-800 text-rose-300 text-xs font-mono flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{submitError}</span>
          </div>
        )}

        {/* Keypad */}
        <DialPad onKeyPress={handleKeyPress} disabled={isSubmitting} />

        {/* Call Controls Button */}
        <CallControls
          onDial={handleDial}
          isValidNumber={isValidNumber}
          isSubmitting={isSubmitting}
        />
      </div>

      {/* Live VU Meter during active call */}
      {isCallActive && <VuMeter />}
    </div>
  );
}
